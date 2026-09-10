-- Atomic payment approval: only tenant manager/super-admin may approve, then bill status is recomputed from approved payments.
CREATE OR REPLACE FUNCTION public.approve_water_payment(p_payment_id UUID)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_tenant UUID;
  v_payment public.payments;
  v_paid NUMERIC;
  v_total NUMERIC;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = v_uid;
  IF v_tenant IS NULL OR NOT ((SELECT public.has_tenant_role(v_tenant,'manager')) OR (SELECT public.is_super_admin())) THEN
    RAISE EXCEPTION 'Insufficient permission';
  END IF;
  UPDATE public.payments SET status='approved'
  WHERE id=p_payment_id AND tenant_id=v_tenant
  RETURNING * INTO v_payment;
  IF v_payment.id IS NULL THEN RAISE EXCEPTION 'Payment not found'; END IF;
  SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status='approved'),0) INTO v_paid
  FROM public.payments p WHERE p.bill_id=v_payment.bill_id;
  SELECT wb.total INTO v_total FROM public.water_bills wb WHERE wb.id=v_payment.bill_id AND wb.tenant_id=v_tenant;
  UPDATE public.water_bills SET status=CASE WHEN v_paid>=v_total THEN 'paid' WHEN v_paid>0 THEN 'partial' ELSE 'unpaid' END
  WHERE id=v_payment.bill_id AND tenant_id=v_tenant;
  RETURN v_payment;
END;
$$;
REVOKE ALL ON FUNCTION public.approve_water_payment(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_water_payment(UUID) TO authenticated;
