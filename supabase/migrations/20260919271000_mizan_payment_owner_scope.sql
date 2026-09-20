-- MIZAN payment owner scope hardening.
-- Platform owners can reconcile payments across tenants; tenant users remain
-- constrained to their own tenant.

CREATE OR REPLACE FUNCTION public.record_water_payment(
  p_bill_id UUID,
  p_amount NUMERIC,
  p_method TEXT DEFAULT 'cash',
  p_client_id TEXT DEFAULT NULL
)
RETURNS TABLE(payment_id UUID, bill_id UUID, amount NUMERIC, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_profile_tenant UUID;
  v_tenant UUID;
  v_super_admin BOOLEAN := public.is_super_admin();
  v_payment UUID;
  v_total NUMERIC;
  v_paid NUMERIC;
  v_outstanding NUMERIC;
  v_reading UUID;
  v_verification TEXT;
  v_client_id TEXT := NULLIF(trim(p_client_id), '');
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT p.tenant_id INTO v_profile_tenant
  FROM public.profiles p WHERE p.id=v_uid;

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount='NaN'::numeric THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;
  IF p_method NOT IN ('cash','bank_transfer') THEN
    RAISE EXCEPTION 'Unsupported payment method';
  END IF;
  IF v_client_id IS NOT NULL AND length(v_client_id) > 160 THEN
    RAISE EXCEPTION 'Client id is too long';
  END IF;

  SELECT wb.tenant_id, wb.total, wb.reading_id
  INTO v_tenant, v_total, v_reading
  FROM public.water_bills wb
  WHERE wb.id=p_bill_id
    AND (v_super_admin OR wb.tenant_id=v_profile_tenant)
  FOR UPDATE;

  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;

  IF NOT v_super_admin AND NOT (
    public.has_tenant_role(v_tenant,'collector')
    OR public.has_tenant_role(v_tenant,'manager')
  ) THEN
    RAISE EXCEPTION 'Collector or manager permission required';
  END IF;

  SELECT wr.verification_status INTO v_verification
  FROM public.water_readings wr
  WHERE wr.id=v_reading AND wr.tenant_id=v_tenant;

  IF v_reading IS NULL OR v_verification <> 'approved' THEN
    RAISE EXCEPTION 'Bill is not eligible for collection';
  END IF;

  IF v_client_id IS NOT NULL THEN
    SELECT p.id INTO v_payment
    FROM public.payments p
    WHERE p.tenant_id=v_tenant AND p.client_id=v_client_id;

    IF v_payment IS NOT NULL THEN
      SELECT p.id,p.bill_id,p.amount,p.status
      INTO payment_id,bill_id,amount,status
      FROM public.payments p WHERE p.id=v_payment;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('approved','pending')),0)
  INTO v_paid
  FROM public.payments p
  WHERE p.bill_id=p_bill_id AND p.tenant_id=v_tenant;

  v_outstanding:=v_total-v_paid;
  IF v_outstanding <= 0 THEN RAISE EXCEPTION 'Bill has no outstanding balance'; END IF;
  IF p_amount > v_outstanding THEN RAISE EXCEPTION 'Payment exceeds the outstanding bill balance'; END IF;

  INSERT INTO public.payments(tenant_id,bill_id,amount,method,status,collector_id,client_id)
  VALUES(v_tenant,p_bill_id,p_amount,p_method,'pending',v_uid,v_client_id)
  RETURNING id,bill_id,amount,status INTO payment_id,bill_id,amount,status;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.record_water_payment(UUID,NUMERIC,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_water_payment(UUID,NUMERIC,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_water_payment(p_payment_id UUID)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_profile_tenant UUID;
  v_tenant UUID;
  v_super_admin BOOLEAN := public.is_super_admin();
  v_payment public.payments;
  v_total NUMERIC;
  v_paid NUMERIC;
  v_reading UUID;
  v_verification TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  SELECT p.tenant_id INTO v_profile_tenant FROM public.profiles p WHERE p.id=v_uid;

  SELECT wb.tenant_id,wb.total,wb.reading_id
  INTO v_tenant,v_total,v_reading
  FROM public.water_bills wb
  WHERE wb.id=(
    SELECT p.bill_id FROM public.payments p WHERE p.id=p_payment_id
      AND (v_super_admin OR p.tenant_id=v_profile_tenant)
  )
    AND (v_super_admin OR wb.tenant_id=v_profile_tenant)
  FOR UPDATE;

  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF NOT v_super_admin AND NOT public.has_tenant_role(v_tenant,'manager') THEN
    RAISE EXCEPTION 'Manager permission required';
  END IF;

  SELECT wr.verification_status INTO v_verification
  FROM public.water_readings wr
  WHERE wr.id=v_reading AND wr.tenant_id=v_tenant;
  IF v_verification <> 'approved' THEN RAISE EXCEPTION 'Bill is not eligible for collection'; END IF;

  SELECT p.* INTO v_payment
  FROM public.payments p
  WHERE p.id=p_payment_id AND p.tenant_id=v_tenant
  FOR UPDATE;

  IF v_payment.id IS NULL OR v_payment.status <> 'pending' THEN
    RAISE EXCEPTION 'Payment not found or is not pending';
  END IF;

  SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status='approved'),0)
  INTO v_paid
  FROM public.payments p
  WHERE p.bill_id=v_payment.bill_id AND p.tenant_id=v_tenant;

  IF v_paid + v_payment.amount > v_total THEN
    RAISE EXCEPTION 'Approved payments would exceed the outstanding bill balance';
  END IF;

  UPDATE public.payments
  SET status='approved'
  WHERE id=p_payment_id AND tenant_id=v_tenant AND status='pending';

  SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status='approved'),0)
  INTO v_paid
  FROM public.payments p
  WHERE p.bill_id=v_payment.bill_id AND p.tenant_id=v_tenant;

  UPDATE public.water_bills
  SET status=CASE WHEN v_paid>=v_total THEN 'paid'
                  WHEN v_paid>0 THEN 'partial'
                  ELSE 'unpaid' END
  WHERE id=v_payment.bill_id AND tenant_id=v_tenant;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES(v_tenant,v_uid,'payment_approved','payment',p_payment_id::text,
    jsonb_build_object('bill_id',v_payment.bill_id,'amount',v_payment.amount,
      'bill_total',v_total,'approved_total',v_paid));

  RETURN (SELECT p FROM public.payments p WHERE p.id=p_payment_id);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_water_payment(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_water_payment(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_water_payment(p_payment_id UUID,p_reason TEXT)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID:=auth.uid();
  v_profile_tenant UUID;
  v_tenant UUID;
  v_super_admin BOOLEAN:=public.is_super_admin();
  v_payment public.payments;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  SELECT p.tenant_id INTO v_profile_tenant FROM public.profiles p WHERE p.id=v_uid;

  SELECT p.tenant_id INTO v_tenant
  FROM public.payments p
  WHERE p.id=p_payment_id
    AND (v_super_admin OR p.tenant_id=v_profile_tenant);

  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF NOT v_super_admin AND NOT public.has_tenant_role(v_tenant,'manager') THEN
    RAISE EXCEPTION 'Manager permission required';
  END IF;
  IF COALESCE(length(trim(p_reason)),0) < 3 OR length(trim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'Rejection reason is required';
  END IF;

  UPDATE public.payments
  SET status='rejected',review_reason=trim(p_reason)
  WHERE id=p_payment_id AND tenant_id=v_tenant AND status='pending'
  RETURNING * INTO v_payment;

  IF v_payment.id IS NULL THEN RAISE EXCEPTION 'Payment not found or is not pending'; END IF;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES(v_tenant,v_uid,'payment_rejected','payment',p_payment_id::text,
    jsonb_build_object('reason',trim(p_reason)));

  RETURN v_payment;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_water_payment(UUID,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_water_payment(UUID,TEXT) TO authenticated;
