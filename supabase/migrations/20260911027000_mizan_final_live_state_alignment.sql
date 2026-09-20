-- MIZAN final live-state alignment.
-- Consolidates the authoritative invariants that must hold after the prior workflow hardening.
-- Browser writes remain RPC-only; tenant scope is derived from auth.uid().

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS review_reason TEXT,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

DROP INDEX IF EXISTS public.payments_client_id_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS payments_tenant_client_id_uidx
  ON public.payments(tenant_id, client_id)
  WHERE client_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS water_readings_one_pending_per_meter_uidx
  ON public.water_readings(tenant_id, meter_id)
  WHERE meter_id IS NOT NULL AND verification_status = 'pending';

CREATE OR REPLACE FUNCTION public.current_billing_cycle(
  p_tenant UUID,
  p_at TIMESTAMPTZ DEFAULT now()
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_current_tenant UUID;
  v_super_admin BOOLEAN := public.is_super_admin();
  v_start TIMESTAMPTZ := date_trunc('month', p_at);
  v_end TIMESTAMPTZ := v_start + interval '1 month';
  v_key TEXT := to_char(v_start, 'YYYY-MM');
  v_id UUID;
BEGIN
  SELECT p.tenant_id INTO v_current_tenant FROM public.profiles p WHERE p.id = v_uid;
  IF v_current_tenant IS NULL AND NOT v_super_admin THEN RAISE EXCEPTION 'No tenant is assigned to the authenticated user'; END IF;
  IF p_tenant IS NULL OR (NOT v_super_admin AND p_tenant <> v_current_tenant) THEN RAISE EXCEPTION 'Tenant scope mismatch'; END IF;
  IF NOT (v_super_admin OR public.has_tenant_role(p_tenant, 'manager')) THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  INSERT INTO public.billing_cycles(tenant_id, cycle_key, starts_at, ends_at, status)
  VALUES (p_tenant, v_key, v_start, v_end, 'open')
  ON CONFLICT (tenant_id, cycle_key) DO UPDATE SET status = public.billing_cycles.status
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid(); v_tenant UUID; v_customer UUID; v_serial TEXT; v_prev NUMERIC;
  v_reading UUID; v_existing public.water_readings; v_profile_id UUID;
  v_decimal_digits SMALLINT; v_integer_digits SMALLINT; v_integer_length INTEGER;
  v_client_id TEXT := NULLIF(trim(p_client_id), '');
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No tenant is assigned to the authenticated user'; END IF;
  IF NOT (public.has_tenant_role(v_tenant,'reader') OR public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Insufficient permission to record readings'; END IF;
  IF p_current IS NULL OR p_current < 0 OR p_current='NaN'::numeric THEN RAISE EXCEPTION 'Invalid current reading'; END IF;
  IF p_capture_source NOT IN ('camera','phone','manual','offline') THEN RAISE EXCEPTION 'Invalid capture source'; END IF;
  IF p_ocr_confidence IS NOT NULL AND (p_ocr_confidence < 0 OR p_ocr_confidence > 1 OR p_ocr_confidence='NaN'::numeric) THEN RAISE EXCEPTION 'Invalid OCR confidence'; END IF;
  IF p_lat IS NOT NULL AND (p_lat < -90 OR p_lat > 90 OR p_lat='NaN'::numeric) THEN RAISE EXCEPTION 'Invalid latitude'; END IF;
  IF p_lng IS NOT NULL AND (p_lng < -180 OR p_lng > 180 OR p_lng='NaN'::numeric) THEN RAISE EXCEPTION 'Invalid longitude'; END IF;
  IF p_accuracy IS NOT NULL AND (p_accuracy < 0 OR p_accuracy='NaN'::numeric) THEN RAISE EXCEPTION 'Invalid GPS accuracy'; END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_tenant::text || ':' || p_meter_id::text, 0));
  SELECT m.customer_id,m.serial_number,m.profile_id INTO v_customer,v_serial,v_profile_id
  FROM public.meters m WHERE m.id=p_meter_id AND m.tenant_id=v_tenant AND m.status='active';
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Meter is not active or is not assigned to this tenant'; END IF;

  IF v_profile_id IS NOT NULL THEN
    SELECT mp.integer_digits,mp.decimal_digits INTO v_integer_digits,v_decimal_digits
    FROM public.meter_profiles mp WHERE mp.id=v_profile_id AND mp.tenant_id=v_tenant;
    IF v_decimal_digits IS NOT NULL AND scale(p_current) > v_decimal_digits THEN RAISE EXCEPTION 'Reading has more decimal places than the meter profile permits'; END IF;
    IF v_integer_digits IS NOT NULL AND v_integer_digits > 0 THEN
      v_integer_length := length(split_part(trunc(abs(p_current))::text, '.', 1));
      IF v_integer_length > v_integer_digits THEN RAISE EXCEPTION 'Reading exceeds the integer digit capacity of the meter profile'; END IF;
    END IF;
  END IF;

  IF p_ocr_serial IS NOT NULL AND regexp_replace(upper(p_ocr_serial),'[^A-Z0-9]','','g') <> regexp_replace(upper(v_serial),'[^A-Z0-9]','','g') THEN RAISE EXCEPTION 'Meter identity mismatch'; END IF;

  IF v_client_id IS NOT NULL THEN
    SELECT wr.* INTO v_existing FROM public.water_readings wr WHERE wr.tenant_id=v_tenant AND wr.client_id=v_client_id FOR UPDATE;
    IF v_existing.id IS NOT NULL THEN
      IF v_existing.meter_id <> p_meter_id OR v_existing.current_reading <> p_current THEN RAISE EXCEPTION 'Idempotency key is already bound to a different reading request'; END IF;
      SELECT v_existing.id,wb.id,v_existing.previous,v_existing.current_reading,v_existing.consumption,wb.total,wb.arrears,COALESCE(t.project_name,t.name)
      INTO reading_id,bill_id,previous,current_reading,consumption,bill_total,arrears,project_name
      FROM public.tenants t LEFT JOIN public.water_bills wb ON wb.reading_id=v_existing.id WHERE t.id=v_tenant;
      RETURN NEXT; RETURN;
    END IF;
  END IF;

  SELECT wr.* INTO v_existing FROM public.water_readings wr
  WHERE wr.tenant_id=v_tenant AND wr.meter_id=p_meter_id AND wr.verification_status='pending'
  ORDER BY wr.created_at DESC LIMIT 1;
  IF v_existing.id IS NOT NULL THEN RAISE EXCEPTION 'A pending reading already exists for this meter'; END IF;

  SELECT wr.current_reading INTO v_prev FROM public.water_readings wr
  WHERE wr.tenant_id=v_tenant AND wr.meter_id=p_meter_id AND wr.verification_status='approved'
  ORDER BY wr.created_at DESC LIMIT 1;
  v_prev:=COALESCE(v_prev,0);
  IF p_current < v_prev THEN RAISE EXCEPTION 'Current reading cannot be lower than previous approved reading'; END IF;

  INSERT INTO public.water_readings(tenant_id,customer_id,meter_number,meter_id,previous,current_reading,consumption,photo_url,lat,lng,flag,status,reader_id,capture_source,ocr_serial,ocr_confidence,ocr_raw_text,identity_verified,reading_verified,client_id,source_device,verification_status)
  VALUES(v_tenant,v_customer,v_serial,p_meter_id,v_prev,p_current,p_current-v_prev,p_photo_url,p_lat,p_lng,CASE WHEN p_current=v_prev THEN 'zero' ELSE 'ok' END,'pending',v_uid,p_capture_source,p_ocr_serial,p_ocr_confidence,p_ocr_raw_text,p_ocr_serial IS NOT NULL,false,v_client_id,NULL,'pending')
  ON CONFLICT (tenant_id,client_id) WHERE client_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_reading;

  IF v_reading IS NULL AND v_client_id IS NOT NULL THEN
    SELECT wr.* INTO v_existing FROM public.water_readings wr WHERE wr.tenant_id=v_tenant AND wr.client_id=v_client_id FOR UPDATE;
    IF v_existing.id IS NULL THEN RAISE EXCEPTION 'Reading idempotency conflict could not be resolved'; END IF;
    IF v_existing.meter_id <> p_meter_id OR v_existing.current_reading <> p_current THEN RAISE EXCEPTION 'Idempotency key is already bound to a different reading request'; END IF;
    v_reading:=v_existing.id;
  END IF;

  reading_id:=v_reading; bill_id:=NULL; previous:=v_prev; current_reading:=p_current; consumption:=p_current-v_prev; bill_total:=NULL; arrears:=NULL;
  SELECT COALESCE(t.project_name,t.name) INTO project_name FROM public.tenants t WHERE t.id=v_tenant;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_water_reading(p_reading_id UUID)
RETURNS TABLE(reading_id UUID, bill_id UUID, status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid UUID:=auth.uid(); v_tenant UUID; v_reading public.water_readings; v_total NUMERIC; v_arrears NUMERIC; v_cycle UUID; v_project TEXT; v_bill UUID;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT (public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  SELECT wr.* INTO v_reading FROM public.water_readings wr WHERE wr.id=p_reading_id AND wr.tenant_id=v_tenant FOR UPDATE;
  IF v_reading.id IS NULL OR v_reading.verification_status<>'pending' THEN RAISE EXCEPTION 'Reading not found or is not pending'; END IF;
  IF v_reading.meter_id IS NULL OR v_reading.customer_id IS NULL THEN RAISE EXCEPTION 'Reading is missing meter/customer linkage'; END IF;
  IF EXISTS (SELECT 1 FROM public.water_bills wb WHERE wb.reading_id=p_reading_id) THEN RAISE EXCEPTION 'Reading already has a bill'; END IF;
  v_cycle:=public.current_billing_cycle(v_tenant,now());
  SELECT COALESCE(SUM(GREATEST(wb.total-COALESCE((SELECT SUM(pp.amount) FROM public.payments pp WHERE pp.bill_id=wb.id AND pp.status='approved'),0),0)),0)
  INTO v_arrears FROM public.water_bills wb WHERE wb.tenant_id=v_tenant AND wb.customer_id=v_reading.customer_id AND wb.status<>'paid' AND wb.id IS DISTINCT FROM NULL;
  v_total:=public.water_charge(v_reading.consumption)+v_arrears;
  SELECT COALESCE(t.project_name,t.name) INTO v_project FROM public.tenants t WHERE t.id=v_tenant;
  INSERT INTO public.water_bills(tenant_id,customer_id,reading_id,subtotal,arrears,total,status,cycle_id,project_name)
  VALUES(v_tenant,v_reading.customer_id,p_reading_id,public.water_charge(v_reading.consumption),v_arrears,v_total,'unpaid',v_cycle,v_project)
  RETURNING id INTO v_bill;
  UPDATE public.water_readings SET verification_status='approved',status='approved',reading_verified=true,review_reason=NULL WHERE id=p_reading_id AND tenant_id=v_tenant;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES(v_tenant,v_uid,'reading_approved','water_reading',p_reading_id::text,jsonb_build_object('bill_id',v_bill,'consumption',v_reading.consumption,'bill_total',v_total,'arrears',v_arrears));
  reading_id:=p_reading_id; bill_id:=v_bill; status:='approved'; RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_water_reading(p_reading_id UUID,p_reason TEXT)
RETURNS TABLE(reading_id UUID,bill_id UUID,status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid UUID:=auth.uid(); v_tenant UUID; v_bill UUID;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT (public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  IF COALESCE(length(trim(p_reason)),0)<3 THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  SELECT wb.id INTO v_bill FROM public.water_bills wb WHERE wb.reading_id=p_reading_id AND wb.tenant_id=v_tenant FOR UPDATE;
  UPDATE public.water_readings SET status='rejected',verification_status='rejected',reading_verified=false,review_reason=trim(p_reason) WHERE id=p_reading_id AND tenant_id=v_tenant AND verification_status='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Reading not found or is not pending'; END IF;
  IF v_bill IS NOT NULL THEN UPDATE public.water_bills SET status='unpaid' WHERE id=v_bill AND tenant_id=v_tenant; END IF;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta) VALUES(v_tenant,v_uid,'reading_rejected','water_reading',p_reading_id::text,jsonb_build_object('reason',trim(p_reason)));
  reading_id:=p_reading_id; bill_id:=v_bill; status:='rejected'; RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_water_payment(p_bill_id UUID,p_amount NUMERIC,p_method TEXT DEFAULT 'cash',p_client_id TEXT DEFAULT NULL)
RETURNS TABLE(payment_id UUID,bill_id UUID,amount NUMERIC,status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid UUID:=auth.uid(); v_tenant UUID; v_total NUMERIC; v_paid NUMERIC; v_reading UUID; v_verification TEXT; v_existing public.payments; v_payment UUID; v_client_id TEXT:=NULLIF(trim(p_client_id),'');
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No tenant is assigned to the authenticated user'; END IF;
  IF NOT (public.has_tenant_role(v_tenant,'collector') OR public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Collector or manager permission required'; END IF;
  IF p_amount IS NULL OR p_amount<=0 OR p_amount='NaN'::numeric THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  IF p_method NOT IN ('cash','bank_transfer') THEN RAISE EXCEPTION 'Unsupported payment method'; END IF;
  IF p_client_id IS NOT NULL AND v_client_id IS NULL THEN RAISE EXCEPTION 'Client id cannot be empty'; END IF;
  SELECT wb.total,wb.reading_id INTO v_total,v_reading FROM public.water_bills wb WHERE wb.id=p_bill_id AND wb.tenant_id=v_tenant FOR UPDATE;
  IF v_total IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;
  SELECT wr.verification_status INTO v_verification FROM public.water_readings wr WHERE wr.id=v_reading AND wr.tenant_id=v_tenant;
  IF v_reading IS NULL OR v_verification<>'approved' THEN RAISE EXCEPTION 'Bill is not eligible for collection'; END IF;
  IF v_client_id IS NOT NULL THEN
    SELECT p.* INTO v_existing FROM public.payments p WHERE p.tenant_id=v_tenant AND p.client_id=v_client_id FOR UPDATE;
    IF v_existing.id IS NOT NULL THEN
      IF v_existing.bill_id<>p_bill_id OR v_existing.amount<>p_amount OR v_existing.method<>p_method THEN RAISE EXCEPTION 'Idempotency key is already bound to a different payment request'; END IF;
      payment_id:=v_existing.id; bill_id:=v_existing.bill_id; amount:=v_existing.amount; status:=v_existing.status; RETURN NEXT; RETURN;
    END IF;
  END IF;
  SELECT COALESCE(SUM(p.amount) FILTER(WHERE p.status IN ('approved','pending')),0) INTO v_paid FROM public.payments p WHERE p.bill_id=p_bill_id AND p.tenant_id=v_tenant;
  IF v_paid+p_amount>v_total THEN RAISE EXCEPTION 'Payment exceeds the outstanding bill balance'; END IF;
  INSERT INTO public.payments(tenant_id,bill_id,amount,method,status,collector_id,client_id)
  VALUES(v_tenant,p_bill_id,p_amount,p_method,'pending',v_uid,v_client_id)
  ON CONFLICT (tenant_id,client_id) WHERE client_id IS NOT NULL DO NOTHING
  RETURNING id,bill_id,amount,status INTO payment_id,bill_id,amount,status;
  IF payment_id IS NULL AND v_client_id IS NOT NULL THEN
    SELECT p.* INTO v_existing FROM public.payments p WHERE p.tenant_id=v_tenant AND p.client_id=v_client_id FOR UPDATE;
    IF v_existing.id IS NULL THEN RAISE EXCEPTION 'Payment idempotency conflict could not be resolved'; END IF;
    IF v_existing.bill_id<>p_bill_id OR v_existing.amount<>p_amount OR v_existing.method<>p_method THEN RAISE EXCEPTION 'Idempotency key is already bound to a different payment request'; END IF;
    payment_id:=v_existing.id; bill_id:=v_existing.bill_id; amount:=v_existing.amount; status:=v_existing.status;
  END IF;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta) VALUES(v_tenant,v_uid,'payment_created','payment',payment_id::text,jsonb_build_object('bill_id',bill_id,'amount',amount,'method',p_method,'status',status));
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_water_payment(p_payment_id UUID)
RETURNS public.payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid UUID:=auth.uid(); v_tenant UUID; v_payment public.payments; v_total NUMERIC; v_paid NUMERIC; v_bill_id UUID; v_reading UUID; v_verification TEXT;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT (public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  SELECT p.bill_id INTO v_bill_id FROM public.payments p WHERE p.id=p_payment_id AND p.tenant_id=v_tenant;
  IF v_bill_id IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;
  SELECT wb.total,wb.reading_id INTO v_total,v_reading FROM public.water_bills wb WHERE wb.id=v_bill_id AND wb.tenant_id=v_tenant FOR UPDATE;
  IF v_total IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;
  SELECT wr.verification_status INTO v_verification FROM public.water_readings wr WHERE wr.id=v_reading AND wr.tenant_id=v_tenant;
  IF v_verification<>'approved' THEN RAISE EXCEPTION 'Bill is not eligible for collection'; END IF;
  SELECT p.* INTO v_payment FROM public.payments p WHERE p.id=p_payment_id AND p.tenant_id=v_tenant FOR UPDATE;
  IF v_payment.id IS NULL OR v_payment.status<>'pending' THEN RAISE EXCEPTION 'Payment not found or is not pending'; END IF;
  SELECT COALESCE(SUM(p.amount) FILTER(WHERE p.status='approved'),0) INTO v_paid FROM public.payments p WHERE p.bill_id=v_bill_id AND p.tenant_id=v_tenant;
  IF v_paid+v_payment.amount>v_total THEN RAISE EXCEPTION 'Approved payments would exceed the outstanding bill balance'; END IF;
  UPDATE public.payments SET status='approved',approved_by=v_uid,approved_at=now(),rejected_at=NULL,review_reason=NULL WHERE id=p_payment_id AND tenant_id=v_tenant AND status='pending';
  SELECT COALESCE(SUM(p.amount) FILTER(WHERE p.status='approved'),0) INTO v_paid FROM public.payments p WHERE p.bill_id=v_bill_id AND p.tenant_id=v_tenant;
  UPDATE public.water_bills SET status=CASE WHEN v_paid>=v_total THEN 'paid' WHEN v_paid>0 THEN 'partial' ELSE 'unpaid' END WHERE id=v_bill_id AND tenant_id=v_tenant;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta) VALUES(v_tenant,v_uid,'payment_approved','payment',p_payment_id::text,jsonb_build_object('bill_id',v_bill_id,'amount',v_payment.amount,'bill_total',v_total,'approved_total',v_paid));
  SELECT p.* INTO v_payment FROM public.payments p WHERE p.id=p_payment_id;
  RETURN v_payment;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_water_payment(p_payment_id UUID,p_reason TEXT)
RETURNS public.payments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid UUID:=auth.uid(); v_tenant UUID; v_payment public.payments;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT (public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  IF COALESCE(length(trim(p_reason)),0)<3 THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  UPDATE public.payments SET status='rejected',review_reason=trim(p_reason),rejected_at=now(),approved_by=NULL,approved_at=NULL WHERE id=p_payment_id AND tenant_id=v_tenant AND status='pending' RETURNING * INTO v_payment;
  IF v_payment.id IS NULL THEN RAISE EXCEPTION 'Payment not found or is not pending'; END IF;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta) VALUES(v_tenant,v_uid,'payment_rejected','payment',p_payment_id::text,jsonb_build_object('reason',trim(p_reason)));
  RETURN v_payment;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_water_bill_status(p_bill_id UUID,p_tenant_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_uid UUID:=auth.uid(); v_current_tenant UUID; v_super_admin BOOLEAN:=public.is_super_admin(); v_total NUMERIC; v_paid NUMERIC; v_status TEXT;
BEGIN
  SELECT p.tenant_id INTO v_current_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_current_tenant IS NULL AND NOT v_super_admin THEN RAISE EXCEPTION 'No tenant is assigned to the authenticated user'; END IF;
  IF p_tenant_id IS NULL OR (NOT v_super_admin AND p_tenant_id<>v_current_tenant) THEN RAISE EXCEPTION 'Tenant scope mismatch'; END IF;
  IF NOT (v_super_admin OR public.has_tenant_role(p_tenant_id,'manager')) THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  SELECT wb.total INTO v_total FROM public.water_bills wb WHERE wb.id=p_bill_id AND wb.tenant_id=p_tenant_id FOR UPDATE;
  IF v_total IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;
  SELECT COALESCE(SUM(p.amount) FILTER(WHERE p.status='approved'),0) INTO v_paid FROM public.payments p WHERE p.bill_id=p_bill_id AND p.tenant_id=p_tenant_id;
  v_status:=CASE WHEN v_paid>=v_total THEN 'paid' WHEN v_paid>0 THEN 'partial' ELSE 'unpaid' END;
  UPDATE public.water_bills SET status=v_status WHERE id=p_bill_id AND tenant_id=p_tenant_id;
  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.current_billing_cycle(UUID,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_water_reading(UUID,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,NUMERIC,NUMERIC,NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_water_reading(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_water_reading(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_water_payment(UUID,NUMERIC,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_water_payment(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_water_payment(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recompute_water_bill_status(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_billing_cycle(UUID,TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_water_reading(UUID,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,NUMERIC,NUMERIC,NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_water_reading(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_water_reading(UUID,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_water_payment(UUID,NUMERIC,TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_water_payment(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_water_payment(UUID,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_water_bill_status(UUID,UUID) TO authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.payments FROM authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.water_bills FROM authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.water_readings FROM authenticated;
