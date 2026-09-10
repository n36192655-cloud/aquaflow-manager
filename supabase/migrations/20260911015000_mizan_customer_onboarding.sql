CREATE OR REPLACE FUNCTION public.create_customer(p_name TEXT, p_phone TEXT DEFAULT NULL, p_address TEXT DEFAULT NULL, p_pay_account TEXT DEFAULT NULL)
RETURNS public.customers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_uid UUID := auth.uid(); v_tenant UUID; v_row public.customers;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT public.has_tenant_role(v_tenant,'manager') THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  IF COALESCE(length(trim(p_name)),0) < 2 THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  INSERT INTO public.customers(tenant_id,name,phone,address,pay_account,status)
  VALUES(v_tenant,trim(p_name),NULLIF(trim(p_phone),''),NULLIF(trim(p_address),''),NULLIF(trim(p_pay_account),''),'active')
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.create_customer(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_customer(TEXT,TEXT,TEXT,TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.deactivate_customer(p_customer_id UUID)
RETURNS public.customers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_uid UUID := auth.uid(); v_tenant UUID; v_row public.customers;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT public.has_tenant_role(v_tenant,'manager') THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  UPDATE public.customers SET status='inactive' WHERE id=p_customer_id AND tenant_id=v_tenant RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Customer not found'; END IF;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.deactivate_customer(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_customer(UUID) TO authenticated;
