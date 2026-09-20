-- MIZAN reading approval audit hardening.
-- Reconcile the live approval path without changing migration history.
-- No service-role runtime path.

CREATE OR REPLACE FUNCTION public.approve_water_reading(p_reading_id UUID)
RETURNS TABLE(reading_id UUID, bill_id UUID, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tenant UUID;
  v_reading public.water_readings;
  v_total NUMERIC;
  v_arrears NUMERIC;
  v_cycle UUID;
  v_project TEXT;
  v_bill UUID;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = v_uid;
  IF v_tenant IS NULL OR NOT (public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Manager permission required';
  END IF;

  SELECT wr.* INTO v_reading
  FROM public.water_readings wr
  WHERE wr.id = p_reading_id AND wr.tenant_id = v_tenant
  FOR UPDATE;

  IF v_reading.id IS NULL OR v_reading.verification_status <> 'pending' THEN
    RAISE EXCEPTION 'Reading not found or is not pending';
  END IF;
  IF v_reading.meter_id IS NULL OR v_reading.customer_id IS NULL THEN
    RAISE EXCEPTION 'Reading is missing meter/customer linkage';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.water_bills wb
    WHERE wb.reading_id = p_reading_id AND wb.tenant_id = v_tenant
  ) THEN
    RAISE EXCEPTION 'Reading already has a bill';
  END IF;

  v_cycle := public.current_billing_cycle(v_tenant, now());
  SELECT COALESCE(SUM(GREATEST(
    wb.total - COALESCE((SELECT SUM(pp.amount) FROM public.payments pp WHERE pp.bill_id = wb.id AND pp.status = 'approved'), 0),
    0
  )), 0)
  INTO v_arrears
  FROM public.water_bills wb
  WHERE wb.tenant_id = v_tenant
    AND wb.customer_id = v_reading.customer_id
    AND wb.status <> 'paid';

  v_total := public.water_charge(v_reading.consumption) + v_arrears;
  SELECT COALESCE(t.project_name, t.name) INTO v_project
  FROM public.tenants t WHERE t.id = v_tenant;

  INSERT INTO public.water_bills(
    tenant_id, customer_id, reading_id, subtotal, arrears, total, status,
    cycle_id, project_name, client_id
  ) VALUES (
    v_tenant, v_reading.customer_id, p_reading_id,
    public.water_charge(v_reading.consumption), v_arrears, v_total,
    'unpaid', v_cycle, v_project, v_reading.client_id
  ) RETURNING id INTO v_bill;

  UPDATE public.water_readings
  SET verification_status = 'approved',
      status = 'approved',
      reading_verified = true,
      verified_by = v_uid,
      verified_at = now(),
      review_reason = NULL,
      rejection_reason = NULL
  WHERE id = p_reading_id
    AND tenant_id = v_tenant
    AND verification_status = 'pending';

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES (
    v_tenant, v_uid, 'reading_approved', 'water_reading', p_reading_id::text,
    jsonb_build_object('bill_id', v_bill, 'consumption', v_reading.consumption,
      'bill_total', v_total, 'arrears', v_arrears)
  );

  reading_id := p_reading_id;
  bill_id := v_bill;
  status := 'approved';
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_water_reading(p_reading_id UUID, p_reason TEXT)
RETURNS TABLE(reading_id UUID, bill_id UUID, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tenant UUID;
  v_bill UUID;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = v_uid;
  IF v_tenant IS NULL OR NOT (public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Manager permission required';
  END IF;
  IF COALESCE(length(trim(p_reason)), 0) < 3 THEN
    RAISE EXCEPTION 'Rejection reason is required';
  END IF;

  SELECT wb.id INTO v_bill
  FROM public.water_bills wb
  WHERE wb.reading_id = p_reading_id AND wb.tenant_id = v_tenant
  FOR UPDATE;

  UPDATE public.water_readings
  SET status = 'rejected',
      verification_status = 'rejected',
      reading_verified = false,
      verified_by = v_uid,
      verified_at = now(),
      review_reason = trim(p_reason),
      rejection_reason = trim(p_reason)
  WHERE id = p_reading_id
    AND tenant_id = v_tenant
    AND verification_status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reading not found or is not pending';
  END IF;

  IF v_bill IS NOT NULL THEN
    UPDATE public.water_bills SET status = 'unpaid'
    WHERE id = v_bill AND tenant_id = v_tenant;
  END IF;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES (
    v_tenant, v_uid, 'reading_rejected', 'water_reading', p_reading_id::text,
    jsonb_build_object('reason', trim(p_reason), 'bill_id', v_bill)
  );

  reading_id := p_reading_id;
  bill_id := v_bill;
  status := 'rejected';
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_water_reading(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_water_reading(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_water_reading(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_water_reading(UUID,TEXT) TO authenticated;
