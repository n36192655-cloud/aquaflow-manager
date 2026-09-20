-- Payment review metadata is part of the authoritative audit workflow.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS review_reason TEXT;

CREATE OR REPLACE FUNCTION public.reject_water_payment(p_payment_id UUID, p_reason TEXT)
RETURNS public.payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tenant UUID;
  v_payment public.payments;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT (public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  IF COALESCE(length(trim(p_reason)),0) < 3 THEN RAISE EXCEPTION 'Rejection reason is required'; END IF;
  UPDATE public.payments
  SET status='rejected', review_reason=trim(p_reason)
  WHERE id=p_payment_id AND tenant_id=v_tenant AND status='pending'
  RETURNING * INTO v_payment;
  IF v_payment.id IS NULL THEN RAISE EXCEPTION 'Payment not found or is not pending'; END IF;
  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES(v_tenant,v_uid,'payment_rejected','payment',p_payment_id::text,jsonb_build_object('reason',trim(p_reason)));
  RETURN v_payment;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_water_payment(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_water_payment(UUID,TEXT) TO authenticated;
