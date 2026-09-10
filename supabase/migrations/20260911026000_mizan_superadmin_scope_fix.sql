-- Super-admins may operate across tenants, but ordinary authenticated users may not.

CREATE OR REPLACE FUNCTION public.current_billing_cycle(
  p_tenant UUID,
  p_at TIMESTAMPTZ DEFAULT now()
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
  SELECT p.tenant_id INTO v_current_tenant
  FROM public.profiles p
  WHERE p.id=v_uid;

  IF v_current_tenant IS NULL AND NOT v_super_admin THEN
    RAISE EXCEPTION 'No tenant is assigned to the authenticated user';
  END IF;
  IF p_tenant IS NULL OR (NOT v_super_admin AND p_tenant <> v_current_tenant) THEN
    RAISE EXCEPTION 'Tenant scope mismatch';
  END IF;
  IF NOT (v_super_admin OR public.has_tenant_role(p_tenant,'manager')) THEN
    RAISE EXCEPTION 'Manager permission required';
  END IF;

  INSERT INTO public.billing_cycles(tenant_id,cycle_key,starts_at,ends_at,status)
  VALUES(p_tenant,v_key,v_start,v_end,'open')
  ON CONFLICT (tenant_id,cycle_key) DO UPDATE
    SET status=public.billing_cycles.status
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.current_billing_cycle(UUID,TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_billing_cycle(UUID,TIMESTAMPTZ) TO authenticated;

CREATE OR REPLACE FUNCTION public.recompute_water_bill_status(p_bill_id UUID,p_tenant_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid UUID:=auth.uid();
  v_current_tenant UUID;
  v_super_admin BOOLEAN:=public.is_super_admin();
  v_total NUMERIC;
  v_paid NUMERIC;
  v_status TEXT;
BEGIN
  SELECT p.tenant_id INTO v_current_tenant FROM public.profiles p WHERE p.id=v_uid;
  IF v_current_tenant IS NULL AND NOT v_super_admin THEN RAISE EXCEPTION 'No tenant is assigned to the authenticated user'; END IF;
  IF p_tenant_id IS NULL OR (NOT v_super_admin AND p_tenant_id<>v_current_tenant) THEN RAISE EXCEPTION 'Tenant scope mismatch'; END IF;
  IF NOT (v_super_admin OR public.has_tenant_role(p_tenant_id,'manager')) THEN RAISE EXCEPTION 'Manager permission required'; END IF;

  SELECT wb.total INTO v_total FROM public.water_bills wb WHERE wb.id=p_bill_id AND wb.tenant_id=p_tenant_id FOR UPDATE;
  IF v_total IS NULL THEN RAISE EXCEPTION 'Bill not found'; END IF;
  SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status='approved'),0) INTO v_paid
  FROM public.payments p WHERE p.bill_id=p_bill_id AND p.tenant_id=p_tenant_id;
  v_status:=CASE WHEN v_paid>=v_total THEN 'paid' WHEN v_paid>0 THEN 'partial' ELSE 'unpaid' END;
  UPDATE public.water_bills SET status=v_status WHERE id=p_bill_id AND tenant_id=p_tenant_id;
  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_water_bill_status(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recompute_water_bill_status(UUID,UUID) TO authenticated;
