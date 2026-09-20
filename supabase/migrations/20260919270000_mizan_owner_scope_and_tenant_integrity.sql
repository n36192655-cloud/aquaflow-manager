-- MIZAN owner-scope and tenant-integrity hardening.
-- Super-admin is the platform owner and may operate across tenants without
-- requiring a profile tenant_id. Ordinary users remain tenant-bound.

CREATE UNIQUE INDEX IF NOT EXISTS tenants_single_central_uidx
  ON public.tenants (tenant_type)
  WHERE tenant_type = 'central';

CREATE OR REPLACE FUNCTION public.create_central_tenant(_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_name text := btrim(_name);
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'super admin required';
  END IF;
  IF length(v_name) < 2 OR length(v_name) > 160 THEN
    RAISE EXCEPTION 'tenant name must be between 2 and 160 characters';
  END IF;

  INSERT INTO public.tenants(
    name, project_name, tenant_type, parent_tenant_id,
    subscription_status, subscription_expires_at
  )
  VALUES (
    v_name, v_name, 'central', NULL, 'active', now() + interval '3650 days'
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES (
    v_id, auth.uid(), 'tenant.created', 'tenant', v_id,
    jsonb_build_object('tenant_type','central','name',v_name)
  );

  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'central tenant already exists';
END;
$$;

REVOKE ALL ON FUNCTION public.create_central_tenant(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_central_tenant(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_project_tenant(_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_name text := btrim(_name);
  v_central uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'super admin required';
  END IF;
  IF length(v_name) < 2 OR length(v_name) > 160 THEN
    RAISE EXCEPTION 'tenant name must be between 2 and 160 characters';
  END IF;

  SELECT id INTO v_central
  FROM public.tenants
  WHERE tenant_type = 'central'
  ORDER BY created_at, id
  LIMIT 1
  FOR UPDATE;

  IF v_central IS NULL THEN
    RAISE EXCEPTION 'central tenant required';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tenants
    WHERE parent_tenant_id = v_central
      AND tenant_type = 'project'
      AND lower(name) = lower(v_name)
  ) THEN
    RAISE EXCEPTION 'project tenant name already exists';
  END IF;

  INSERT INTO public.tenants(
    name, project_name, tenant_type, parent_tenant_id,
    subscription_status, subscription_expires_at
  )
  VALUES (
    v_name, v_name, 'project', v_central, 'active', now() + interval '365 days'
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES (
    v_id, auth.uid(), 'tenant.created', 'tenant', v_id,
    jsonb_build_object('tenant_type','project','name',v_name,'parent_tenant_id',v_central)
  );

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_project_tenant(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_project_tenant(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_water_reading(
  p_meter_id UUID,
  p_current NUMERIC,
  p_photo_url TEXT DEFAULT NULL,
  p_capture_source TEXT DEFAULT 'manual',
  p_ocr_serial TEXT DEFAULT NULL,
  p_ocr_confidence NUMERIC DEFAULT NULL,
  p_ocr_raw_text TEXT DEFAULT NULL,
  p_client_id TEXT DEFAULT NULL,
  p_lat NUMERIC DEFAULT NULL,
  p_lng NUMERIC DEFAULT NULL,
  p_accuracy NUMERIC DEFAULT NULL
)
RETURNS TABLE(
  reading_id UUID, bill_id UUID, previous NUMERIC, current_reading NUMERIC,
  consumption NUMERIC, bill_total NUMERIC, arrears NUMERIC, project_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_profile_tenant UUID;
  v_tenant UUID;
  v_super_admin BOOLEAN := public.is_super_admin();
  v_customer UUID;
  v_serial TEXT;
  v_prev NUMERIC;
  v_reading UUID;
  v_existing public.water_readings;
  v_profile_id UUID;
  v_decimal_digits SMALLINT;
  v_integer_digits SMALLINT;
  v_integer_length INTEGER;
  v_client_id TEXT := NULLIF(trim(p_client_id), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT p.tenant_id INTO v_profile_tenant
  FROM public.profiles p
  WHERE p.id = v_uid;

  IF p_current IS NULL OR p_current < 0 OR p_current = 'NaN'::numeric THEN
    RAISE EXCEPTION 'Invalid current reading';
  END IF;
  IF p_capture_source NOT IN ('camera','phone','manual','offline') THEN
    RAISE EXCEPTION 'Invalid capture source';
  END IF;
  IF p_ocr_confidence IS NOT NULL
     AND (p_ocr_confidence < 0 OR p_ocr_confidence > 1 OR p_ocr_confidence = 'NaN'::numeric) THEN
    RAISE EXCEPTION 'Invalid OCR confidence';
  END IF;
  IF p_lat IS NOT NULL AND (p_lat < -90 OR p_lat > 90 OR p_lat = 'NaN'::numeric) THEN
    RAISE EXCEPTION 'Invalid latitude';
  END IF;
  IF p_lng IS NOT NULL AND (p_lng < -180 OR p_lng > 180 OR p_lng = 'NaN'::numeric) THEN
    RAISE EXCEPTION 'Invalid longitude';
  END IF;
  IF p_accuracy IS NOT NULL AND (p_accuracy < 0 OR p_accuracy = 'NaN'::numeric) THEN
    RAISE EXCEPTION 'Invalid GPS accuracy';
  END IF;
  IF v_client_id IS NOT NULL AND length(v_client_id) > 160 THEN
    RAISE EXCEPTION 'Client id is too long';
  END IF;

  IF v_super_admin THEN
    SELECT m.tenant_id, m.customer_id, m.serial_number, m.profile_id
    INTO v_tenant, v_customer, v_serial, v_profile_id
    FROM public.meters m
    WHERE m.id = p_meter_id AND m.status = 'active';
  ELSE
    v_tenant := v_profile_tenant;
    IF v_tenant IS NULL
       OR NOT (
         public.has_tenant_role(v_tenant,'reader')
         OR public.has_tenant_role(v_tenant,'manager')
       ) THEN
      RAISE EXCEPTION 'Insufficient permission to record readings';
    END IF;

    SELECT m.customer_id, m.serial_number, m.profile_id
    INTO v_customer, v_serial, v_profile_id
    FROM public.meters m
    WHERE m.id = p_meter_id
      AND m.tenant_id = v_tenant
      AND m.status = 'active';
  END IF;

  IF v_tenant IS NULL OR v_customer IS NULL THEN
    RAISE EXCEPTION 'Meter is not active or is not accessible';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant::text || ':' || p_meter_id::text, 0)
  );

  IF v_profile_id IS NOT NULL THEN
    SELECT mp.integer_digits, mp.decimal_digits
    INTO v_integer_digits, v_decimal_digits
    FROM public.meter_profiles mp
    WHERE mp.id = v_profile_id AND mp.tenant_id = v_tenant;

    IF v_decimal_digits IS NOT NULL AND scale(p_current) > v_decimal_digits THEN
      RAISE EXCEPTION 'Reading has more decimal places than the meter profile permits';
    END IF;

    IF v_integer_digits IS NOT NULL AND v_integer_digits > 0 THEN
      v_integer_length := length(abs(trunc(p_current))::bigint::text);
      IF v_integer_length > v_integer_digits THEN
        RAISE EXCEPTION 'Reading exceeds the integer digit capacity of the meter profile';
      END IF;
    END IF;
  END IF;

  IF p_ocr_serial IS NOT NULL
     AND regexp_replace(upper(p_ocr_serial),'[^A-Z0-9]','','g')
       <> regexp_replace(upper(v_serial),'[^A-Z0-9]','','g') THEN
    RAISE EXCEPTION 'Meter identity mismatch';
  END IF;

  IF v_client_id IS NOT NULL THEN
    SELECT wr.* INTO v_existing
    FROM public.water_readings wr
    WHERE wr.tenant_id = v_tenant AND wr.client_id = v_client_id;

    IF v_existing.id IS NOT NULL THEN
      IF v_existing.meter_id <> p_meter_id OR v_existing.current_reading <> p_current THEN
        RAISE EXCEPTION 'Idempotency key is already bound to a different reading request';
      END IF;

      SELECT v_existing.id, wb.id, v_existing.previous, v_existing.current_reading,
             v_existing.consumption, wb.total, wb.arrears, COALESCE(t.project_name,t.name)
      INTO reading_id, bill_id, previous, current_reading, consumption,
           bill_total, arrears, project_name
      FROM public.tenants t
      LEFT JOIN public.water_bills wb ON wb.reading_id = v_existing.id
      WHERE t.id = v_tenant;

      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  SELECT wr.* INTO v_existing
  FROM public.water_readings wr
  WHERE wr.tenant_id = v_tenant
    AND wr.meter_id = p_meter_id
    AND wr.verification_status = 'pending'
  ORDER BY wr.created_at DESC
  LIMIT 1;

  IF v_existing.id IS NOT NULL THEN
    RAISE EXCEPTION 'A pending reading already exists for this meter';
  END IF;

  SELECT wr.current_reading INTO v_prev
  FROM public.water_readings wr
  WHERE wr.tenant_id = v_tenant
    AND wr.meter_id = p_meter_id
    AND wr.verification_status = 'approved'
  ORDER BY wr.created_at DESC
  LIMIT 1;

  v_prev := COALESCE(v_prev, 0);
  IF p_current < v_prev THEN
    RAISE EXCEPTION 'Current reading cannot be lower than previous approved reading';
  END IF;

  INSERT INTO public.water_readings(
    tenant_id,customer_id,meter_number,meter_id,previous,current_reading,consumption,
    photo_url,lat,lng,flag,status,reader_id,capture_source,ocr_serial,ocr_confidence,
    ocr_raw_text,identity_verified,reading_verified,client_id,source_device,verification_status
  )
  VALUES(
    v_tenant,v_customer,v_serial,p_meter_id,v_prev,p_current,p_current-v_prev,
    p_photo_url,p_lat,p_lng,CASE WHEN p_current=v_prev THEN 'zero' ELSE 'ok' END,
    'pending',v_uid,p_capture_source,p_ocr_serial,p_ocr_confidence,p_ocr_raw_text,
    p_ocr_serial IS NOT NULL,false,v_client_id,NULL,'pending'
  )
  RETURNING id INTO v_reading;

  reading_id := v_reading;
  bill_id := NULL;
  previous := v_prev;
  current_reading := p_current;
  consumption := p_current-v_prev;
  bill_total := NULL;
  arrears := NULL;
  SELECT COALESCE(t.project_name,t.name) INTO project_name
  FROM public.tenants t WHERE t.id=v_tenant;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.record_water_reading(UUID,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,NUMERIC,NUMERIC,NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_water_reading(UUID,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,NUMERIC,NUMERIC,NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_water_reading(p_reading_id UUID)
RETURNS TABLE(reading_id UUID,bill_id UUID,bill_total NUMERIC,arrears NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_profile_tenant UUID;
  v_tenant UUID;
  v_super_admin BOOLEAN := public.is_super_admin();
  v_customer UUID;
  v_consumption NUMERIC;
  v_status TEXT;
  v_client_id TEXT;
  v_cycle UUID;
  v_project TEXT;
  v_bill UUID;
  v_charge JSONB;
  v_subtotal NUMERIC;
  v_arrears NUMERIC;
  v_total NUMERIC;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT p.tenant_id INTO v_profile_tenant
  FROM public.profiles p WHERE p.id=v_uid;

  IF v_super_admin THEN
    SELECT wr.tenant_id, wr.customer_id, wr.consumption, wr.verification_status, wr.client_id
    INTO v_tenant, v_customer, v_consumption, v_status, v_client_id
    FROM public.water_readings wr
    WHERE wr.id=p_reading_id
    FOR UPDATE;
  ELSE
    v_tenant := v_profile_tenant;
    IF v_tenant IS NULL OR NOT public.has_tenant_role(v_tenant,'manager') THEN
      RAISE EXCEPTION 'Manager permission required';
    END IF;

    SELECT wr.customer_id, wr.consumption, wr.verification_status, wr.client_id
    INTO v_customer, v_consumption, v_status, v_client_id
    FROM public.water_readings wr
    WHERE wr.id=p_reading_id AND wr.tenant_id=v_tenant
    FOR UPDATE;
  END IF;

  IF v_customer IS NULL THEN RAISE EXCEPTION 'Reading not found'; END IF;
  IF v_status <> 'pending' THEN RAISE EXCEPTION 'Reading is not pending'; END IF;

  v_charge := public.calculate_water_charge(v_tenant,v_customer,v_consumption,30,CURRENT_DATE);
  v_subtotal := COALESCE((v_charge ->> 'subtotal')::NUMERIC,0);

  SELECT COALESCE(SUM(
    GREATEST(
      wb.total - COALESCE((
        SELECT SUM(pp.amount)
        FROM public.payments pp
        WHERE pp.bill_id=wb.id AND pp.status='approved'
      ),0),0
    )),0)
  INTO v_arrears
  FROM public.water_bills wb
  WHERE wb.tenant_id=v_tenant
    AND wb.customer_id=v_customer
    AND wb.status<>'paid';

  v_total := v_subtotal + v_arrears;
  v_project := (SELECT COALESCE(t.project_name,t.name) FROM public.tenants t WHERE t.id=v_tenant);
  v_cycle := public.current_billing_cycle(v_tenant,now());

  UPDATE public.water_readings
  SET verification_status='approved',status='approved',reading_verified=true,
      verified_by=v_uid,verified_at=now(),review_reason=NULL,rejection_reason=NULL
  WHERE id=p_reading_id AND tenant_id=v_tenant AND verification_status='pending';

  SELECT wb.id INTO v_bill
  FROM public.water_bills wb
  WHERE wb.reading_id=p_reading_id AND wb.tenant_id=v_tenant
  ORDER BY wb.created_at DESC LIMIT 1
  FOR UPDATE;

  IF v_bill IS NULL THEN
    INSERT INTO public.water_bills(
      tenant_id,customer_id,reading_id,subtotal,arrears,total,status,
      cycle_id,project_name,client_id
    )
    VALUES(
      v_tenant,v_customer,p_reading_id,v_subtotal,v_arrears,v_total,'unpaid',
      v_cycle,v_project,v_client_id
    )
    RETURNING id INTO v_bill;
  ELSE
    UPDATE public.water_bills
    SET subtotal=v_subtotal,arrears=v_arrears,total=v_total,
        cycle_id=v_cycle,project_name=v_project,client_id=COALESCE(client_id,v_client_id)
    WHERE id=v_bill AND tenant_id=v_tenant;
  END IF;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES(
    v_tenant,v_uid,'reading_approved','water_reading',p_reading_id::text,
    jsonb_build_object('bill_id',v_bill,'bill_total',v_total,'arrears',v_arrears,
      'tariff_plan_id',v_charge->>'plan_id','tariff_category',v_charge->>'category')
  );

  reading_id:=p_reading_id; bill_id:=v_bill; bill_total:=v_total; arrears:=v_arrears;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_water_reading(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_water_reading(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_water_reading(p_reading_id UUID,p_reason TEXT)
RETURNS TABLE(reading_id UUID,bill_id UUID,status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID:=auth.uid();
  v_profile_tenant UUID;
  v_tenant UUID;
  v_super_admin BOOLEAN:=public.is_super_admin();
  v_bill UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  SELECT p.tenant_id INTO v_profile_tenant FROM public.profiles p WHERE p.id=v_uid;

  IF v_super_admin THEN
    SELECT wr.tenant_id INTO v_tenant
    FROM public.water_readings wr
    WHERE wr.id=p_reading_id;
  ELSE
    v_tenant:=v_profile_tenant;
    IF v_tenant IS NULL OR NOT public.has_tenant_role(v_tenant,'manager') THEN
      RAISE EXCEPTION 'Manager permission required';
    END IF;
  END IF;

  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Reading not found'; END IF;
  IF COALESCE(length(trim(p_reason)),0) < 3 OR length(trim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'Rejection reason is required';
  END IF;

  SELECT wb.id INTO v_bill
  FROM public.water_bills wb
  WHERE wb.reading_id=p_reading_id AND wb.tenant_id=v_tenant
  FOR UPDATE;

  UPDATE public.water_readings
  SET status='rejected',verification_status='rejected',reading_verified=false,
      verified_by=v_uid,verified_at=now(),review_reason=trim(p_reason),
      rejection_reason=trim(p_reason)
  WHERE id=p_reading_id AND tenant_id=v_tenant AND verification_status='pending';

  IF NOT FOUND THEN RAISE EXCEPTION 'Reading not found or is not pending'; END IF;

  IF v_bill IS NOT NULL THEN
    UPDATE public.water_bills SET status='unpaid'
    WHERE id=v_bill AND tenant_id=v_tenant;
  END IF;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES(v_tenant,v_uid,'reading_rejected','water_reading',p_reading_id::text,
    jsonb_build_object('reason',trim(p_reason),'bill_id',v_bill));

  reading_id:=p_reading_id; bill_id:=v_bill; status:='rejected';
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_water_reading(UUID,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_water_reading(UUID,TEXT) TO authenticated;
