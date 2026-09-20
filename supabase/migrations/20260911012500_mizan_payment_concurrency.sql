-- Payment concurrency hardening: serialize collection against the bill row.
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
  v_tenant UUID;
  v_payment UUID;
  v_total NUMERIC;
  v_paid NUMERIC;
  v_outstanding NUMERIC;
  v_reading UUID;
  v_verification TEXT;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No tenant is assigned to the authenticated user'; END IF;
  IF NOT (public.has_tenant_role(v_tenant,'collector') OR public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Collector or manager permission required'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be greater than zero'; END IF;
  IF p_method NOT IN ('cash','bank_transfer') THEN RAISE EXCEPTION 'Unsupported payment method'; END IF;

  -- Lock the bill first so two collectors cannot both consume the same outstanding balance.
  SELECT wb.total, wb.reading_id INTO v_total, v_reading
  FROM public.water_bills wb
  WHERE wb.id=p_bill_id AND wb.tenant_id=v_tenant
  FOR UPDATE;
  IF v_total IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;
  SELECT wr.verification_status INTO v_verification FROM public.water_readings wr WHERE wr.id=v_reading AND wr.tenant_id=v_tenant;
  IF v_reading IS NULL OR v_verification <> 'approved' THEN RAISE EXCEPTION 'Bill is not eligible for collection'; END IF;

  IF p_client_id IS NOT NULL THEN
    SELECT p.id INTO v_payment FROM public.payments p WHERE p.tenant_id=v_tenant AND p.client_id=p_client_id;
    IF v_payment IS NOT NULL THEN
      SELECT p.id,p.bill_id,p.amount,p.status INTO payment_id,bill_id,amount,status FROM public.payments p WHERE p.id=v_payment;
      RETURN NEXT; RETURN;
    END IF;
  END IF;

  SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('approved','pending')),0) INTO v_paid
  FROM public.payments p WHERE p.bill_id=p_bill_id AND p.tenant_id=v_tenant;
  v_outstanding := v_total - v_paid;
  IF v_outstanding <= 0 THEN RAISE EXCEPTION 'Bill has no outstanding balance'; END IF;
  IF p_amount > v_outstanding THEN RAISE EXCEPTION 'Payment exceeds the outstanding bill balance'; END IF;

  INSERT INTO public.payments(tenant_id,bill_id,amount,method,status,collector_id,client_id)
  VALUES(v_tenant,p_bill_id,p_amount,p_method,'pending',v_uid,p_client_id)
  RETURNING id,bill_id,amount,status INTO payment_id,bill_id,amount,status;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_water_payment(p_payment_id UUID)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tenant UUID;
  v_payment public.payments;
  v_paid NUMERIC;
  v_total NUMERIC;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id= v_uid;
  IF v_tenant IS NULL OR NOT (public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Manager permission required'; END IF;

  SELECT p.* INTO v_payment FROM public.payments p WHERE p.id=p_payment_id AND p.tenant_id=v_tenant FOR UPDATE;
  IF v_payment.id IS NULL OR v_payment.status <> 'pending' THEN RAISE EXCEPTION 'Payment not found or is not pending'; END IF;
  SELECT wb.total INTO v_total FROM public.water_bills wb WHERE wb.id=v_payment.bill_id AND wb.tenant_id=v_tenant FOR UPDATE;
  IF v_total IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;

  UPDATE public.payments SET status='approved' WHERE id=p_payment_id AND tenant_id=v_tenant;
  SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status='approved'),0) INTO v_paid FROM public.payments p WHERE p.bill_id=v_payment.bill_id AND p.tenant_id=v_tenant;
  UPDATE public.water_bills SET status=CASE WHEN v_paid>=v_total THEN 'paid' WHEN v_paid>0 THEN 'partial' ELSE 'unpaid' END WHERE id=v_payment.bill_id AND tenant_id=v_tenant;
  RETURN (SELECT p FROM public.payments p WHERE p.id=p_payment_id);
END;
$$;

REVOKE ALL ON FUNCTION public.record_water_payment(UUID,NUMERIC,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_water_payment(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_water_payment(UUID,NUMERIC,TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_water_payment(UUID) TO authenticated;
