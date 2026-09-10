-- Controlled onboarding for real meter profiles and meters. No records are seeded.
CREATE OR REPLACE FUNCTION public.create_meter_profile(
  p_name TEXT,
  p_display_type TEXT,
  p_integer_digits SMALLINT,
  p_decimal_digits SMALLINT,
  p_register_order TEXT DEFAULT 'integer_then_decimal',
  p_color_semantics JSONB DEFAULT '{}'::jsonb
)
RETURNS public.meter_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_uid UUID := auth.uid(); v_tenant UUID; v_row public.meter_profiles;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT public.has_tenant_role(v_tenant,'manager') THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  IF COALESCE(length(trim(p_name)),0) < 2 THEN RAISE EXCEPTION 'Profile name is required'; END IF;
  IF p_display_type NOT IN ('digital','mechanical','analog','circular','hybrid') THEN RAISE EXCEPTION 'Invalid meter display type'; END IF;
  IF p_integer_digits < 0 OR p_integer_digits > 12 OR p_decimal_digits < 0 OR p_decimal_digits > 6 THEN RAISE EXCEPTION 'Invalid digit configuration'; END IF;
  INSERT INTO public.meter_profiles(tenant_id,name,display_type,integer_digits,decimal_digits,register_order,color_semantics)
  VALUES(v_tenant,trim(p_name),p_display_type,p_integer_digits,p_decimal_digits,COALESCE(p_register_order,'integer_then_decimal'),COALESCE(p_color_semantics,'{}'::jsonb))
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.create_meter_profile(TEXT,TEXT,SMALLINT,SMALLINT,TEXT,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_meter_profile(TEXT,TEXT,SMALLINT,SMALLINT,TEXT,JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_meter(p_customer_id UUID, p_serial_number TEXT, p_profile_id UUID)
RETURNS public.meters
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_uid UUID := auth.uid(); v_tenant UUID; v_customer UUID; v_profile UUID; v_row public.meters;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT public.has_tenant_role(v_tenant,'manager') THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  IF COALESCE(length(trim(p_serial_number)),0) < 2 THEN RAISE EXCEPTION 'Meter serial number is required'; END IF;
  SELECT c.id INTO v_customer FROM public.customers c WHERE c.id=p_customer_id AND c.tenant_id=v_tenant AND c.status='active';
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Customer not found in current tenant'; END IF;
  SELECT mp.id INTO v_profile FROM public.meter_profiles mp WHERE mp.id=p_profile_id AND mp.tenant_id=v_tenant;
  IF v_profile IS NULL THEN RAISE EXCEPTION 'Meter profile not found in current tenant'; END IF;
  INSERT INTO public.meters(tenant_id,customer_id,profile_id,serial_number,status)
  VALUES(v_tenant,v_customer,v_profile,trim(p_serial_number),'active')
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.create_meter(UUID,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_meter(UUID,TEXT,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.deactivate_meter(p_meter_id UUID)
RETURNS public.meters
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_uid UUID := auth.uid(); v_tenant UUID; v_row public.meters;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_tenant IS NULL OR NOT public.has_tenant_role(v_tenant,'manager') THEN RAISE EXCEPTION 'Manager permission required'; END IF;
  UPDATE public.meters SET status='inactive' WHERE id=p_meter_id AND tenant_id=v_tenant RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'Meter not found'; END IF;
  RETURN v_row;
END;
$$;
REVOKE ALL ON FUNCTION public.deactivate_meter(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_meter(UUID) TO authenticated;
