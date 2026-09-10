CREATE OR REPLACE FUNCTION public.approve_water_payment(p_payment_id uuid)
RETURNS TABLE(payment_id uuid, bill_id uuid, approved_amount numeric, bill_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_bill_id uuid;
  v_amount numeric;
  v_status text;
  v_paid numeric;
  v_total numeric;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No tenant is assigned to the authenticated user'; END IF;
  IF NOT (public.has_tenant_role(v_tenant, 'manager') OR public.has_role(v_uid, 'super_admin')) THEN
    RAISE EXCEPTION 'Insufficient permission to approve payments';
  END IF;

  SELECT p.bill_id, p.amount, p.status INTO v_bill_id, v_amount, v_status
  FROM public.payments p
  WHERE p.id = p_payment_id AND p.tenant_id = v_tenant
  FOR UPDATE;
  IF v_bill_id IS NULL THEN RAISE EXCEPTION 'Payment is not available for this project'; END IF;
  IF v_status <> 'pending' THEN RAISE EXCEPTION 'Payment is not pending'; END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;

  SELECT b.total INTO v_total FROM public.water_bills b WHERE b.id = v_bill_id AND b.tenant_id = v_tenant FOR UPDATE;
  IF v_total IS NULL THEN RAISE EXCEPTION 'Bill is not available for this project'; END IF;

  SELECT COALESCE(SUM(p.amount),0) INTO v_paid
  FROM public.payments p
  WHERE p.bill_id = v_bill_id AND p.tenant_id = v_tenant AND p.status = 'approved' AND p.id <> p_payment_id;
  IF v_paid + v_amount > v_total THEN RAISE EXCEPTION 'Approved payments cannot exceed bill total'; END IF;

  UPDATE public.payments SET status = 'approved' WHERE id = p_payment_id;

  v_paid := v_paid + v_amount;
  v_status := CASE WHEN v_paid >= v_total THEN 'paid' WHEN v_paid > 0 THEN 'partial' ELSE 'unpaid' END;
  UPDATE public.water_bills SET status = v_status WHERE id = v_bill_id AND tenant_id = v_tenant;

  payment_id := p_payment_id;
  bill_id := v_bill_id;
  approved_amount := v_amount;
  bill_status := v_status;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_water_payment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_water_payment(uuid) TO authenticated;
