-- MIZAN reading workflow hardening.
-- Preserve the existing RPC signature while changing the business transition to pending -> approved -> bill.

ALTER TABLE public.water_readings
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS water_readings_tenant_verification_idx
  ON public.water_readings(tenant_id, verification_status, created_at DESC);

UPDATE public.water_readings
SET verification_status = CASE
  WHEN status = 'approved' THEN 'approved'
  WHEN status = 'rejected' THEN 'rejected'
  ELSE 'pending'
END
WHERE verification_status = 'pending';

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
RETURNS TABLE(reading_id UUID, bill_id UUID, previous NUMERIC, current_reading NUMERIC, consumption NUMERIC, bill_total NUMERIC, arrears NUMERIC, project_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tenant UUID;
  v_customer UUID;
  v_serial TEXT;
  v_prev NUMERIC;
  v_consumption NUMERIC;
  v_reading UUID;
  v_existing_bill UUID;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No tenant is assigned to the authenticated user'; END IF;
  IF NOT (public.has_tenant_role(v_tenant,'reader') OR public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Insufficient permission to record readings'; END IF;
  IF p_current IS NULL OR p_current < 0 THEN RAISE EXCEPTION 'Reading must be zero or greater'; END IF;
  IF p_capture_source NOT IN ('camera','phone','manual','offline') THEN RAISE EXCEPTION 'Unsupported capture source'; END IF;
  IF p_ocr_confidence IS NOT NULL AND (p_ocr_confidence < 0 OR p_ocr_confidence > 1) THEN RAISE EXCEPTION 'OCR confidence must be between 0 and 1'; END IF;
  IF p_lat IS NOT NULL AND (p_lat < -90 OR p_lat > 90) THEN RAISE EXCEPTION 'Invalid latitude'; END IF;
  IF p_lng IS NOT NULL AND (p_lng < -180 OR p_lng > 180) THEN RAISE EXCEPTION 'Invalid longitude'; END IF;
  IF p_accuracy IS NOT NULL AND p_accuracy < 0 THEN RAISE EXCEPTION 'Invalid GPS accuracy'; END IF;

  SELECT m.customer_id,m.serial_number INTO v_customer,v_serial
  FROM public.meters m WHERE m.id=p_meter_id AND m.tenant_id=v_tenant AND m.status='active';
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Meter is not active or is not assigned to this tenant'; END IF;
  IF p_ocr_serial IS NOT NULL AND regexp_replace(upper(p_ocr_serial),'[^A-Z0-9]','','g') <> regexp_replace(upper(v_serial),'[^A-Z0-9]','','g') THEN RAISE EXCEPTION 'Meter identity mismatch'; END IF;

  IF p_client_id IS NOT NULL THEN
    SELECT wr.id INTO v_reading FROM public.water_readings wr WHERE wr.tenant_id=v_tenant AND wr.client_id=p_client_id;
    IF v_reading IS NOT NULL THEN
      SELECT wb.id,wr.previous,wr.current_reading,wr.consumption,wb.total,wb.arrears,COALESCE(wb.project_name,t.project_name,t.name)
      INTO bill_id,previous,current_reading,consumption,bill_total,arrears,project_name
      FROM public.water_readings wr JOIN public.tenants t ON t.id=wr.tenant_id
      LEFT JOIN public.water_bills wb ON wb.reading_id=wr.id
      WHERE wr.id=v_reading;
      reading_id:=v_reading; RETURN NEXT; RETURN;
    END IF;
  END IF;

  SELECT wr.current_reading INTO v_prev FROM public.water_readings wr
  WHERE wr.tenant_id=v_tenant AND wr.meter_id=p_meter_id AND wr.verification_status='approved'
  ORDER BY wr.created_at DESC LIMIT 1;
  v_prev:=COALESCE(v_prev,0);
  IF p_current < v_prev THEN RAISE EXCEPTION 'Current reading cannot be lower than previous approved reading'; END IF;
  v_consumption:=p_current-v_prev;

  INSERT INTO public.water_readings(
    tenant_id,customer_id,meter_number,meter_id,previous,current_reading,consumption,photo_url,lat,lng,
    flag,status,reader_id,capture_source,ocr_serial,ocr_confidence,ocr_raw_text,identity_verified,
    reading_verified,client_id,source_device,verification_status
  ) VALUES(
    v_tenant,v_customer,v_serial,p_meter_id,v_prev,p_current,v_consumption,p_photo_url,p_lat,p_lng,
    'ok','pending',v_uid,p_capture_source,p_ocr_serial,p_ocr_confidence,p_ocr_raw_text,
    p_ocr_serial IS NOT NULL,false,p_client_id,NULL,'pending'
  ) RETURNING id INTO v_reading;

  reading_id:=v_reading; bill_id:=NULL; previous:=v_prev; current_reading:=p_current; consumption:=v_consumption; bill_total:=NULL; arrears:=NULL; project_name:=NULL;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_water_reading(p_reading_id UUID)
RETURNS TABLE(reading_id UUID,bill_id UUID,bill_total NUMERIC,arrears NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid UUID:=auth.uid(); v_tenant UUID; v_customer UUID; v_consumption NUMERIC; v_subtotal NUMERIC; v_arrears NUMERIC;
  v_cycle UUID; v_project TEXT; v_bill UUID; v_status TEXT; v_client_id TEXT;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT (public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  SELECT wr.customer_id,wr.consumption,wr.verification_status,wr.client_id INTO v_customer,v_consumption,v_status,v_client_id
  FROM public.water_readings wr WHERE wr.id=p_reading_id AND wr.tenant_id=v_tenant FOR UPDATE;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Reading not found'; END IF;
  IF v_status <> 'pending' THEN RAISE EXCEPTION 'Reading is not pending'; END IF;
  v_subtotal:=public.water_charge(v_consumption);
  SELECT COALESCE(SUM(GREATEST(wb.total-COALESCE((SELECT SUM(pp.amount) FROM public.payments pp WHERE pp.bill_id=wb.id AND pp.status='approved'),0),0)),0)
  INTO v_arrears FROM public.water_bills wb WHERE wb.tenant_id=v_tenant AND wb.customer_id=v_customer AND wb.status<>'paid';
  SELECT COALESCE(t.project_name,t.name) INTO v_project FROM public.tenants t WHERE t.id=v_tenant;
  v_cycle:=public.current_billing_cycle(v_tenant,now());
  UPDATE public.water_readings SET verification_status='approved',status='approved',reading_verified=true,verified_by=v_uid,verified_at=now()
  WHERE id=p_reading_id AND tenant_id=v_tenant AND verification_status='pending';

  SELECT wb.id INTO v_bill FROM public.water_bills wb WHERE wb.reading_id=p_reading_id AND wb.tenant_id=v_tenant ORDER BY wb.created_at DESC LIMIT 1 FOR UPDATE;
  IF v_bill IS NULL THEN
    INSERT INTO public.water_bills(tenant_id,customer_id,reading_id,subtotal,arrears,total,status,cycle_id,project_name,client_id)
    VALUES(v_tenant,v_customer,p_reading_id,v_subtotal,v_arrears,v_subtotal+v_arrears,'unpaid',v_cycle,v_project,v_client_id) RETURNING id INTO v_bill;
  ELSE
    UPDATE public.water_bills SET subtotal=v_subtotal,arrears=v_arrears,total=v_subtotal+v_arrears,cycle_id=v_cycle,project_name=v_project,client_id=COALESCE(client_id,v_client_id)
    WHERE id=v_bill AND tenant_id=v_tenant;
  END IF;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES(v_tenant,v_uid,'reading_approved','water_reading',p_reading_id::text,jsonb_build_object('bill_id',v_bill,'bill_total',v_subtotal+v_arrears));
  reading_id:=p_reading_id; bill_id:=v_bill; bill_total:=v_subtotal+v_arrears; arrears:=v_arrears; RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_water_reading(p_reading_id UUID,p_reason TEXT)
RETURNS public.water_readings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE v_uid UUID:=auth.uid(); v_tenant UUID; v_reading public.water_readings;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT (public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  IF COALESCE(length(trim(p_reason)),0)<3 THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  UPDATE public.water_readings SET verification_status='rejected',status='rejected',rejection_reason=trim(p_reason),verified_by=v_uid,verified_at=now()
  WHERE id=p_reading_id AND tenant_id=v_tenant AND verification_status='pending' RETURNING * INTO v_reading;
  IF v_reading.id IS NULL THEN RAISE EXCEPTION 'Reading not found or is not pending'; END IF;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES(v_tenant,v_uid,'reading_rejected','water_reading',p_reading_id::text,jsonb_build_object('reason',trim(p_reason)));
  RETURN v_reading;
END;
$$;

REVOKE ALL ON FUNCTION public.record_water_reading(UUID,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,NUMERIC,NUMERIC,NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_water_reading(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_water_reading(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_water_reading(UUID,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,NUMERIC,NUMERIC,NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_water_reading(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_water_reading(UUID,TEXT) TO authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.water_readings FROM authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.water_bills FROM authenticated;
