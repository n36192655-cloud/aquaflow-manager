-- Harden progressive tariff calculation against tier gaps/overlaps.
-- The configured LPD bands must be contiguous from 0; otherwise billing fails closed.

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
  IF p_tenant_id IS NULL OR p_customer_id IS NULL OR p_consumption_m3 IS NULL
     OR p_consumption_m3 < 0 OR p_period_days < 1 OR p_period_days > 366 THEN
    RAISE EXCEPTION 'Invalid billing input';
  END IF;

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
    v_seen_tiers := v_seen_tiers + 1;

    IF v_tier.min_lpd <> v_expected_min_lpd THEN
      RAISE EXCEPTION 'Invalid tariff tiers: bands must be contiguous from 0 LPD';
    END IF;

    IF v_tier.max_lpd IS NULL THEN
      -- An open-ended band is valid only as the final tier.
      IF EXISTS (
        SELECT 1
        FROM public.water_tariff_tiers later_t
        WHERE later_t.plan_id = v_plan.id
          AND later_t.sort_order > v_tier.sort_order
      ) THEN
        RAISE EXCEPTION 'Invalid tariff tiers: open-ended band must be last';
      END IF;
    ELSE
      IF v_tier.max_lpd <= v_tier.min_lpd THEN
        RAISE EXCEPTION 'Invalid tariff tiers: max LPD must exceed min LPD';
      END IF;
    END IF;

    v_tier_lower_m3 := (v_tier.min_lpd * v_household_size * p_period_days) / 1000;
    v_tier_upper_m3 := CASE
      WHEN v_tier.max_lpd IS NULL THEN NULL
      ELSE (v_tier.max_lpd * v_household_size * p_period_days) / 1000
    END;

    IF v_tier_upper_m3 IS NULL THEN
      v_tier_m3 := GREATEST(0, p_consumption_m3 - v_tier_lower_m3);
    ELSE
      v_tier_m3 := GREATEST(
        0,
        LEAST(p_consumption_m3, v_tier_upper_m3) - v_tier_lower_m3
      );
    END IF;

    IF v_tier_m3 > 0 THEN
      v_total := v_total + v_tier_m3 * v_tier.rate_per_m3;
      v_lines := v_lines || jsonb_build_object(
        'tier', v_tier.label,
        'from_m3', v_tier_lower_m3,
        'to_m3', CASE WHEN v_tier_upper_m3 IS NULL THEN NULL ELSE v_tier_upper_m3 END,
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
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.calculate_water_charge(UUID,UUID,NUMERIC,INTEGER,DATE)
  TO authenticated, service_role;
