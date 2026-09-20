-- MIZAN final billing authority reconciliation.
-- Ensure managers can calculate tariffs, remove service-role execution from the
-- client-facing tariff RPC, and make approval return the exact stored bill totals.

CREATE OR REPLACE FUNCTION public.calculate_water_charge(
  p_tenant_id UUID,
  p_customer_id UUID,
  p_consumption_m3 NUMERIC,
  p_period_days INTEGER DEFAULT 30,
  p_period_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_household_size INTEGER;
  v_plan public.water_tariff_plans;
  v_plan_count INTEGER;
  v_tier public.water_tariff_tiers;
  v_total NUMERIC := 0;
  v_remaining NUMERIC := GREATEST(COALESCE(p_consumption_m3, 0), 0);
  v_from_m3 NUMERIC := 0;
  v_tier_lower_m3 NUMERIC;
  v_tier_upper_m3 NUMERIC;
  v_tier_m3 NUMERIC;
  v_daily NUMERIC;
  v_category TEXT;
  v_lines JSONB := '[]'::jsonb;
  v_expected_min_lpd NUMERIC := 0;
  v_previous_max_lpd NUMERIC;
  v_seen_tiers INTEGER := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_tenant_id IS NULL OR p_customer_id IS NULL OR p_consumption_m3 IS NULL
     OR p_consumption_m3 < 0 OR p_consumption_m3 = 'NaN'::numeric
     OR p_period_days < 1 OR p_period_days > 366
     OR p_period_date IS NULL THEN
    RAISE EXCEPTION 'Invalid billing input';
  END IF;

  IF public.current_tenant_id() IS DISTINCT FROM p_tenant_id
     OR NOT (
       public.has_tenant_role(p_tenant_id, 'reader'::public.app_role)
       OR public.has_tenant_role(p_tenant_id, 'manager'::public.app_role)
       OR public.is_super_admin()
     ) THEN
    RAISE EXCEPTION 'Tenant permission required';
  END IF;

  SELECT c.household_size INTO v_household_size
  FROM public.customers c
  WHERE c.id = p_customer_id
    AND c.tenant_id = p_tenant_id
    AND c.status = 'active';

  IF v_household_size IS NULL THEN
    RAISE EXCEPTION 'Active customer not found';
  END IF;

  SELECT count(*) INTO v_plan_count
  FROM public.water_tariff_plans p
  WHERE p.tenant_id = p_tenant_id
    AND p.active
    AND p.effective_from <= p_period_date
    AND (p.effective_to IS NULL OR p.effective_to >= p_period_date);

  IF v_plan_count <> 1 THEN
    RAISE EXCEPTION 'Exactly one active tariff plan must cover the billing date';
  END IF;

  SELECT p.* INTO v_plan
  FROM public.water_tariff_plans p
  WHERE p.tenant_id = p_tenant_id
    AND p.active
    AND p.effective_from <= p_period_date
    AND (p.effective_to IS NULL OR p.effective_to >= p_period_date)
  LIMIT 1;

  v_daily := (p_consumption_m3 * 1000) / (v_household_size * p_period_days);

  IF v_daily < v_plan.basic_lpd THEN
    v_category := 'low';
  ELSIF v_daily <= v_plan.benchmark_lpd THEN
    v_category := 'within_benchmark';
  ELSIF v_daily <= v_plan.optimal_lpd THEN
    v_category := 'conservation';
  ELSE
    v_category := 'high';
  END IF;

  FOR v_tier IN
    SELECT t.*
    FROM public.water_tariff_tiers t
    WHERE t.plan_id = v_plan.id
    ORDER BY t.sort_order, t.min_lpd
  LOOP
    v_seen_tiers := v_seen_tiers + 1;

    IF v_tier.min_lpd <> v_expected_min_lpd THEN
      RAISE EXCEPTION 'Invalid tariff tiers: bands must be contiguous from 0 LPD';
    END IF;

    IF v_tier.max_lpd IS NULL THEN
      IF EXISTS (
        SELECT 1
        FROM public.water_tariff_tiers later_t
        WHERE later_t.plan_id = v_plan.id
          AND later_t.sort_order > v_tier.sort_order
      ) THEN
        RAISE EXCEPTION 'Invalid tariff tiers: open-ended band must be last';
      END IF;
    ELSIF v_tier.max_lpd <= v_tier.min_lpd THEN
      RAISE EXCEPTION 'Invalid tariff tiers: max LPD must exceed min LPD';
    END IF;

    v_tier_lower_m3 := (v_tier.min_lpd * v_household_size * p_period_days) / 1000;
    v_tier_upper_m3 := CASE
      WHEN v_tier.max_lpd IS NULL THEN NULL
      ELSE (v_tier.max_lpd * v_household_size * p_period_days) / 1000
    END;

    IF v_tier_upper_m3 IS NULL THEN
      v_tier_m3 := GREATEST(0, p_consumption_m3 - v_tier_lower_m3);
    ELSE
      v_tier_m3 := GREATEST(0, LEAST(p_consumption_m3, v_tier_upper_m3) - v_tier_lower_m3);
    END IF;

    IF v_tier_m3 > 0 THEN
      v_total := v_total + v_tier_m3 * v_tier.rate_per_m3;
      v_lines := v_lines || jsonb_build_object(
        'tier', v_tier.label,
        'from_m3', v_tier_lower_m3,
        'to_m3', v_tier_upper_m3,
        'quantity_m3', v_tier_m3,
        'rate_per_m3', v_tier.rate_per_m3,
        'amount', v_tier_m3 * v_tier.rate_per_m3
      );
      v_from_m3 := GREATEST(v_from_m3, LEAST(p_consumption_m3, COALESCE(v_tier_upper_m3, p_consumption_m3)));
    END IF;

    v_previous_max_lpd := v_tier.max_lpd;
    v_expected_min_lpd := v_tier.max_lpd;
    EXIT WHEN v_tier.max_lpd IS NULL OR p_consumption_m3 <= COALESCE(v_tier_upper_m3, p_consumption_m3);
  END LOOP;

  IF v_seen_tiers = 0 THEN
    RAISE EXCEPTION 'No tariff tiers configured for active water tariff';
  END IF;
  IF v_previous_max_lpd IS NOT NULL
     AND p_consumption_m3 > (v_previous_max_lpd * v_household_size * p_period_days) / 1000 THEN
    RAISE EXCEPTION 'Tariff does not cover full consumption';
  END IF;
  IF v_from_m3 < p_consumption_m3 THEN
    RAISE EXCEPTION 'Tariff does not cover full consumption';
  END IF;

  RETURN jsonb_build_object(
    'tenant_id', p_tenant_id,
    'customer_id', p_customer_id,
    'household_size', v_household_size,
    'consumption_m3', p_consumption_m3,
    'period_days', p_period_days,
    'litres_per_person_day', round(v_daily, 2),
    'category', v_category,
    'plan_id', v_plan.id,
    'plan_name', v_plan.name,
    'currency_code', v_plan.currency_code,
    'subtotal', round(v_total, 3),
    'lines', v_lines
  );
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_water_charge(UUID,UUID,NUMERIC,INTEGER,DATE)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.calculate_water_charge(UUID,UUID,NUMERIC,INTEGER,DATE)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_water_reading(p_reading_id UUID)
RETURNS TABLE(reading_id UUID,bill_id UUID,bill_total NUMERIC,arrears NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tenant UUID;
  v_customer UUID;
  v_consumption NUMERIC;
  v_status TEXT;
  v_client_id TEXT;
  v_cycle UUID;
  v_project TEXT;
  v_bill UUID;
  v_charge JSONB;
  v_subtotal NUMERIC;
  v_arrears NUMERIC;
  v_total NUMERIC;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;

  SELECT p.tenant_id INTO v_tenant
  FROM public.profiles p
  WHERE p.id = v_uid;

  IF v_tenant IS NULL OR NOT (
    public.has_tenant_role(v_tenant,'manager')
    OR public.is_super_admin()
  ) THEN
    RAISE EXCEPTION 'Manager permission required';
  END IF;

  SELECT wr.customer_id, wr.consumption, wr.verification_status, wr.client_id
  INTO v_customer, v_consumption, v_status, v_client_id
  FROM public.water_readings wr
  WHERE wr.id = p_reading_id
    AND wr.tenant_id = v_tenant
  FOR UPDATE;

  IF v_customer IS NULL THEN RAISE EXCEPTION 'Reading not found'; END IF;
  IF v_status <> 'pending' THEN RAISE EXCEPTION 'Reading is not pending'; END IF;

  v_charge := public.calculate_water_charge(
    v_tenant,
    v_customer,
    v_consumption,
    30,
    CURRENT_DATE
  );
  v_subtotal := COALESCE((v_charge ->> 'subtotal')::NUMERIC, 0);

  SELECT COALESCE(SUM(
    GREATEST(
      wb.total - COALESCE((
        SELECT SUM(pp.amount)
        FROM public.payments pp
        WHERE pp.bill_id = wb.id
          AND pp.status = 'approved'
      ), 0),
      0
    )
  ), 0)
  INTO v_arrears
  FROM public.water_bills wb
  WHERE wb.tenant_id = v_tenant
    AND wb.customer_id = v_customer
    AND wb.status <> 'paid';

  v_total := v_subtotal + v_arrears;
  v_project := (SELECT COALESCE(t.project_name,t.name) FROM public.tenants t WHERE t.id=v_tenant);
  v_cycle := public.current_billing_cycle(v_tenant, now());

  UPDATE public.water_readings
  SET verification_status='approved',
      status='approved',
      reading_verified=true,
      verified_by=v_uid,
      verified_at=now()
  WHERE id=p_reading_id
    AND tenant_id=v_tenant
    AND verification_status='pending';

  SELECT wb.id INTO v_bill
  FROM public.water_bills wb
  WHERE wb.reading_id=p_reading_id
    AND wb.tenant_id=v_tenant
  ORDER BY wb.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_bill IS NULL THEN
    INSERT INTO public.water_bills(
      tenant_id,customer_id,reading_id,subtotal,arrears,total,status,
      cycle_id,project_name,client_id
    )
    VALUES(
      v_tenant,v_customer,p_reading_id,v_subtotal,v_arrears,v_total,'unpaid',
      v_cycle,v_project,v_client_id
    )
    RETURNING id INTO v_bill;
  ELSE
    UPDATE public.water_bills
    SET subtotal=v_subtotal,
        arrears=v_arrears,
        total=v_total,
        cycle_id=v_cycle,
        project_name=v_project,
        client_id=COALESCE(client_id,v_client_id)
    WHERE id=v_bill
      AND tenant_id=v_tenant;
  END IF;

  INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
  VALUES(
    v_tenant,v_uid,'reading_approved','water_reading',p_reading_id::text,
    jsonb_build_object(
      'bill_id',v_bill,
      'bill_total',v_total,
      'tariff_plan_id',v_charge->>'plan_id',
      'tariff_category',v_charge->>'category'
    )
  );

  reading_id:=p_reading_id;
  bill_id:=v_bill;
  bill_total:=v_total;
  arrears:=v_arrears;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_water_reading(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_water_reading(UUID) TO authenticated;
