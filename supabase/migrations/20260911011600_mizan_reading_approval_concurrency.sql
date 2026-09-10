-- Reconcile legacy bills and make approval idempotent under concurrent requests.
CREATE OR REPLACE FUNCTION public.approve_water_reading(p_reading_id UUID)
RETURNS TABLE(reading_id UUID, bill_id UUID, bill_total NUMERIC, arrears NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tenant UUID;
  v_customer UUID;
  v_consumption NUMERIC;
  v_subtotal NUMERIC;
  v_arrears NUMERIC;
  v_cycle UUID;
  v_project TEXT;
  v_bill UUID;
  v_status TEXT;
  v_client_id TEXT;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = v_uid;
  IF v_tenant IS NULL OR NOT (public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Manager permission required';
  END IF;

  SELECT wr.customer_id, wr.consumption, wr.verification_status, wr.client_id
  INTO v_customer, v_consumption, v_status, v_client_id
  FROM public.water_readings wr
  WHERE wr.id = p_reading_id AND wr.tenant_id = v_tenant
  FOR UPDATE;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Reading not found'; END IF;
  IF v_status <> 'pending' THEN RAISE EXCEPTION 'Reading is not pending'; END IF;

  v_subtotal := public.water_charge(v_consumption);
  SELECT COALESCE(SUM(GREATEST(wb.total - COALESCE((SELECT SUM(pp.amount) FROM public.payments pp WHERE pp.bill_id = wb.id AND pp.status='approved'),0),0)),0)
  INTO v_arrears
  FROM public.water_bills wb
  WHERE wb.tenant_id = v_tenant AND wb.customer_id = v_customer AND wb.status <> 'paid';
  SELECT COALESCE(t.project_name, t.name) INTO v_project FROM public.tenants t WHERE t.id = v_tenant;
  v_cycle := public.current_billing_cycle(v_tenant, now());

  UPDATE public.water_readings
  SET verification_status='approved', status='approved', reading_verified=true, verified_by=v_uid, verified_at=now()
  WHERE id=p_reading_id AND tenant_id=v_tenant AND verification_status='pending';

  -- Reuse an existing legacy bill if one already points at this reading; never create a duplicate.
  SELECT wb.id INTO v_bill
  FROM public.water_bills wb
  WHERE wb.id IS NOT NULL AND wb.reading_id = p_reading_id AND wb.tenant_id = v_tenant
  ORDER BY wb.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_bill IS NULL THEN
    INSERT INTO public.water_bills(tenant_id, customer_id, reading_id, subtotal, arrears, total, status, cycle_id, project_name, client_id)
    VALUES(v_tenant, v_customer, p_reading_id, v_subtotal, v_arrears, v_subtotal + v_arrears, 'unpaid', v_cycle, v_project, v_client_id)
    RETURNING id INTO v_bill;
  ELSE
    UPDATE public.water_bills
    SET subtotal=v_subtotal, arrears=v_arrears, total=v_subtotal+v_arrears, cycle_id=v_cycle, project_name=v_project, client_id=COALESCE(client_id,v_client_id)
    WHERE id=v_bill AND tenant_id=v_tenant;
  END IF;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES(v_tenant,v_uid,'reading_approved','water_reading',p_reading_id::text,jsonb_build_object('bill_id',v_bill,'bill_total',v_subtotal+v_arrears));

  reading_id := p_reading_id; bill_id := v_bill; bill_total := v_subtotal + v_arrears; arrears := v_arrears;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_water_reading(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_water_reading(UUID) TO authenticated;
