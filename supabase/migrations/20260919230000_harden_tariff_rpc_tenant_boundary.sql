-- Harden the tariff calculation RPC against cross-tenant authenticated calls.
-- service_role retains explicit cross-tenant capability for trusted server-side work.
-- Authenticated callers must be inside the tenant they request and hold a tenant role.

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
  v_tier public.water_tariff_tiers;
  v_total NUMERIC := 0;
  v_remaining NUMERIC := GREATEST(COALESCE(p_consumption_m3, 0), 0);
  v_from_m3 NUMERIC := 0;
  v_to_m3 NUMERIC;
  v_tier_m3 NUMERIC;
  v_daily NUMERIC;
  v_category TEXT;
  v_lines JSONB := '[]'::jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_customer_id IS NULL OR p_consumption_m3 IS NULL
     OR p_consumption_m3 < 0 OR p_period_days < 1 OR p_period_days > 366 THEN
    RAISE EXCEPTION 'Invalid billing input';
  END IF;

  -- Never trust a tenant identifier supplied by an authenticated client.
  -- service_role is reserved for trusted server-side operations.
  IF auth.uid() IS NOT NULL THEN
    IF public.current_tenant_id() IS DISTINCT FROM p_tenant_id
       OR NOT public.has_tenant_role(p_tenant_id, 'reader'::public.app_role) THEN
      RAISE EXCEPTION 'Tenant permission required';
    END IF;
  END IF;

  SELECT c.household_size INTO v_household_size
  FROM public.customers c
  WHERE c.id = p_customer_id
    AND c.tenant_id = p_tenant_id
    AND c.status = 'active';

  IF v_household_size IS NULL THEN
    RAISE EXCEPTION 'Active customer not found';
  END IF;

  SELECT p.* INTO v_plan
  FROM public.water_tariff_plans p
  WHERE p.tenant_id = p_tenant_id
    AND p.active
    AND p.effective_from <= p_period_date
    AND (p.effective_to IS NULL OR p.effective_to >= p_period_date)
  ORDER BY p.effective_from DESC
  LIMIT 1;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'No active water tariff configured for project';
  END IF;

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
    SELECT t.* FROM public.water_tariff_tiers t
    WHERE t.plan_id = v_plan.id
    ORDER BY t.sort_order, t.min_lpd
  LOOP
    EXIT WHEN v_remaining <= 0;

    v_to_m3 := CASE
      WHEN v_tier.max_lpd IS NULL THEN NULL
      ELSE (v_tier.max_lpd * v_household_size * p_period_days) / 1000
    END;

    IF v_to_m3 IS NULL THEN
      v_tier_m3 := v_remaining;
    ELSE
      v_tier_m3 := GREATEST(0, LEAST(v_remaining, v_to_m3 - v_from_m3));
    END IF;

    IF v_tier_m3 > 0 AND p_consumption_m3 > v_from_m3 THEN
      v_total := v_total + v_tier_m3 * v_tier.rate_per_m3;
      v_lines := v_lines || jsonb_build_object(
        'tier', v_tier.label,
        'from_m3', v_from_m3,
        'to_m3', v_from_m3 + v_tier_m3,
        'quantity_m3', v_tier_m3,
        'rate_per_m3', v_tier.rate_per_m3,
        'amount', v_tier_m3 * v_tier.rate_per_m3
      );
      v_from_m3 := v_from_m3 + v_tier_m3;
      v_remaining := p_consumption_m3 - v_from_m3;
    END IF;
  END LOOP;

  IF v_remaining > 0 THEN
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
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.calculate_water_charge(UUID,UUID,NUMERIC,INTEGER,DATE)
  TO authenticated, service_role;
