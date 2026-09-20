-- Mizan production household, tariff and water-efficiency foundation.
-- WHO reference: 20 L/person/day basic access, ~50 intermediate access,
-- 100+ optimal access. These are service-level benchmarks, not a WHO tariff law.
-- Source: WHO Domestic water quantity, service level and health, 2nd ed. (2020).
-- Tariff amounts remain project-configurable; existing Mizan water rates are used
-- as the initial operational baseline for backward compatibility.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS household_size INTEGER NOT NULL DEFAULT 1
  CHECK (household_size BETWEEN 1 AND 100);

CREATE TABLE IF NOT EXISTS public.water_tariff_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'YER' CHECK (currency_code ~ '^[A-Z]{3}$'),
  benchmark_lpd NUMERIC(8,2) NOT NULL DEFAULT 50 CHECK (benchmark_lpd > 0),
  basic_lpd NUMERIC(8,2) NOT NULL DEFAULT 20 CHECK (basic_lpd > 0 AND basic_lpd <= benchmark_lpd),
  optimal_lpd NUMERIC(8,2) NOT NULL DEFAULT 100 CHECK (optimal_lpd >= benchmark_lpd),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS water_tariff_one_active_plan
  ON public.water_tariff_plans (tenant_id)
  WHERE active = true AND effective_to IS NULL;

CREATE INDEX IF NOT EXISTS water_tariff_plans_tenant_idx
  ON public.water_tariff_plans (tenant_id, effective_from DESC);

CREATE TABLE IF NOT EXISTS public.water_tariff_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES public.water_tariff_plans(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  min_lpd NUMERIC(8,2) NOT NULL CHECK (min_lpd >= 0),
  max_lpd NUMERIC(8,2),
  rate_per_m3 NUMERIC(14,3) NOT NULL CHECK (rate_per_m3 >= 0),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (max_lpd IS NULL OR max_lpd > min_lpd)
);

CREATE UNIQUE INDEX IF NOT EXISTS water_tariff_tiers_order_uidx
  ON public.water_tariff_tiers (plan_id, sort_order);

CREATE INDEX IF NOT EXISTS water_tariff_tiers_lookup_idx
  ON public.water_tariff_tiers (plan_id, min_lpd);

ALTER TABLE public.water_tariff_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.water_tariff_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS water_tariff_plans_select ON public.water_tariff_plans;
CREATE POLICY water_tariff_plans_select ON public.water_tariff_plans
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id());

DROP POLICY IF EXISTS water_tariff_plans_manage ON public.water_tariff_plans;
CREATE POLICY water_tariff_plans_manage ON public.water_tariff_plans
  FOR ALL TO authenticated
  USING (tenant_id = public.current_tenant_id() AND public.has_tenant_role(tenant_id, 'manager'::public.app_role))
  WITH CHECK (tenant_id = public.current_tenant_id() AND public.has_tenant_role(tenant_id, 'manager'::public.app_role));

DROP POLICY IF EXISTS water_tariff_tiers_select ON public.water_tariff_tiers;
CREATE POLICY water_tariff_tiers_select ON public.water_tariff_tiers
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.water_tariff_plans p
    WHERE p.id = plan_id AND p.tenant_id = public.current_tenant_id()
  ));

DROP POLICY IF EXISTS water_tariff_tiers_manage ON public.water_tariff_tiers;
CREATE POLICY water_tariff_tiers_manage ON public.water_tariff_tiers
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.water_tariff_plans p
    WHERE p.id = plan_id
      AND p.tenant_id = public.current_tenant_id()
      AND public.has_tenant_role(p.tenant_id, 'manager'::public.app_role)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.water_tariff_plans p
    WHERE p.id = plan_id
      AND p.tenant_id = public.current_tenant_id()
      AND public.has_tenant_role(p.tenant_id, 'manager'::public.app_role)
  ));

REVOKE ALL ON TABLE public.water_tariff_plans FROM anon;
REVOKE ALL ON TABLE public.water_tariff_tiers FROM anon;

-- PostgreSQL requires every parameter after a defaulted parameter to
-- have a default too. Keep the legacy four-argument call compatible while
-- making household size mandatory on the production five-argument path.
DROP FUNCTION IF EXISTS public.create_customer(TEXT,TEXT,TEXT,TEXT);
DROP FUNCTION IF EXISTS public.create_customer(TEXT,TEXT,TEXT,TEXT,INTEGER);

CREATE FUNCTION public.create_customer(
  p_name TEXT,
  p_phone TEXT DEFAULT NULL,
  p_address TEXT DEFAULT NULL,
  p_pay_account TEXT DEFAULT NULL
)
RETURNS public.customers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $
BEGIN
  RETURN public.create_customer(p_name, p_phone, p_address, p_pay_account, 1);
END;
$;

CREATE FUNCTION public.create_customer(
  p_name TEXT,
  p_phone TEXT,
  p_address TEXT,
  p_pay_account TEXT,
  p_household_size INTEGER
)
RETURNS public.customers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $
DECLARE
  v_tenant_id UUID := public.current_tenant_id();
  v_customer public.customers;
BEGIN
  IF v_tenant_id IS NULL OR NOT public.has_tenant_role(v_tenant_id, 'manager'::public.app_role) THEN
    RAISE EXCEPTION 'Manager permission required';
  END IF;
  IF length(trim(COALESCE(p_name, ''))) < 2 OR length(trim(p_name)) > 200 THEN
    RAISE EXCEPTION 'Invalid customer name';
  END IF;
  IF p_household_size IS NULL OR p_household_size < 1 OR p_household_size > 100 THEN
    RAISE EXCEPTION 'Invalid household size';
  END IF;

  INSERT INTO public.customers (
    tenant_id, name, phone, address, pay_account, household_size, status
  )
  VALUES (
    v_tenant_id, trim(p_name), NULLIF(trim(p_phone), ''), NULLIF(trim(p_address), ''),
    NULLIF(trim(p_pay_account), ''), p_household_size, 'active'
  )
  RETURNING * INTO v_customer;

  RETURN v_customer;
END;
$;

REVOKE ALL ON FUNCTION public.create_customer(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_customer(TEXT,TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_customer(TEXT,TEXT,TEXT,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_customer(TEXT,TEXT,TEXT,TEXT,INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.simulate_household_water_use(
  p_household_size INTEGER,
  p_consumption_m3 NUMERIC,
  p_days INTEGER DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_lpd NUMERIC;
  v_category TEXT;
  v_message TEXT;
BEGIN
  IF p_household_size IS NULL OR p_household_size < 1 OR p_household_size > 100
     OR p_consumption_m3 IS NULL OR p_consumption_m3 < 0
     OR p_days IS NULL OR p_days < 1 OR p_days > 366 THEN
    RAISE EXCEPTION 'Invalid household simulation input';
  END IF;

  v_lpd := (p_consumption_m3 * 1000) / (p_household_size * p_days);

  IF v_lpd < 20 THEN
    v_category := 'low';
    v_message := 'الاستهلاك منخفض؛ تحقق من انتظام الخدمة والقراءة قبل اعتباره ترشيداً.';
  ELSIF v_lpd <= 50 THEN
    v_category := 'within_benchmark';
    v_message := 'الاستهلاك ضمن نطاق 20–50 لتر للفرد يومياً.';
  ELSIF v_lpd <= 100 THEN
    v_category := 'conservation';
    v_message := 'الاستهلاك أعلى من معيار 50 لتر للفرد يومياً؛ يُستحسن التوعية والترشيد.';
  ELSE
    v_category := 'high';
    v_message := 'الاستهلاك مرتفع جداً مقارنة بمؤشرات WHO؛ يلزم التحقق من التسرب والقراءة وسلوك الاستخدام.';
  END IF;

  RETURN jsonb_build_object(
    'household_size', p_household_size,
    'consumption_m3', p_consumption_m3,
    'days', p_days,
    'litres_per_person_day', round(v_lpd, 2),
    'basic_lpd_reference', 20,
    'benchmark_lpd_reference', 50,
    'optimal_lpd_reference', 100,
    'category', v_category,
    'message', v_message
  );
END;
$$;

REVOKE ALL ON FUNCTION public.simulate_household_water_use(INTEGER,NUMERIC,INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.simulate_household_water_use(INTEGER,NUMERIC,INTEGER) TO authenticated;

ALTER TABLE public.water_bills
  ADD COLUMN IF NOT EXISTS tariff_plan_id UUID REFERENCES public.water_tariff_plans(id),
  ADD COLUMN IF NOT EXISTS tariff_category TEXT,
  ADD COLUMN IF NOT EXISTS consumption_lpd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS tariff_breakdown JSONB NOT NULL DEFAULT '[]'::jsonb;

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

  SELECT c.household_size INTO v_household_size
  FROM public.customers c
  WHERE c.id = p_customer_id AND c.tenant_id = p_tenant_id AND c.status = 'active';

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

REVOKE ALL ON FUNCTION public.calculate_water_charge(UUID,UUID,NUMERIC,INTEGER,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_water_charge(UUID,UUID,NUMERIC,INTEGER,DATE) TO authenticated, service_role;

-- Enforce database-side pricing on newly generated water bills.
CREATE OR REPLACE FUNCTION public.apply_configured_water_tariff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_charge JSONB;
  v_arrears NUMERIC := GREATEST(COALESCE(NEW.arrears, 0), 0);
BEGIN
  IF NEW.reading_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT public.calculate_water_charge(
    NEW.tenant_id,
    NEW.customer_id,
    wr.consumption,
    GREATEST(1, COALESCE(EXTRACT(DAY FROM (NEW.issued_at::date - lagged.issued_date))::INTEGER, 30)),
    NEW.issued_at::date
  )
  INTO v_charge
  FROM public.water_readings wr
  LEFT JOIN LATERAL (
    SELECT b.issued_at::date AS issued_date
    FROM public.water_bills b
    WHERE b.customer_id = NEW.customer_id
      AND b.tenant_id = NEW.tenant_id
      AND b.id <> NEW.id
      AND b.issued_at < NEW.issued_at
    ORDER BY b.issued_at DESC
    LIMIT 1
  ) lagged ON true
  WHERE wr.id = NEW.reading_id
    AND wr.tenant_id = NEW.tenant_id;

  IF v_charge IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.subtotal := COALESCE((v_charge ->> 'subtotal')::NUMERIC, 0);
  NEW.arrears := v_arrears;
  NEW.total := NEW.subtotal + NEW.arrears;
  NEW.tariff_plan_id := (v_charge ->> 'plan_id')::UUID;
  NEW.tariff_category := v_charge ->> 'category';
  NEW.consumption_lpd := (v_charge ->> 'litres_per_person_day')::NUMERIC;
  NEW.tariff_breakdown := COALESCE(v_charge -> 'lines', '[]'::jsonb);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS water_bills_configured_tariff_bi ON public.water_bills;
CREATE TRIGGER water_bills_configured_tariff_bi
BEFORE INSERT ON public.water_bills
FOR EACH ROW
EXECUTE FUNCTION public.apply_configured_water_tariff();

REVOKE ALL ON FUNCTION public.apply_configured_water_tariff() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_configured_water_tariff() TO service_role;

-- Seed the current Mizan pricing as an editable project tariff.
-- Rates preserve the existing application baseline: 100 / 200 / 350 YER per m3.
INSERT INTO public.water_tariff_plans (
  tenant_id, name, currency_code, benchmark_lpd, basic_lpd, optimal_lpd
)
SELECT t.id, 'Mizan progressive water tariff — configurable', 'YER', 50, 20, 100
FROM public.tenants t
WHERE t.tenant_type = 'project'
  AND t.subscription_status = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM public.water_tariff_plans p
    WHERE p.tenant_id = t.id AND p.active
  );

INSERT INTO public.water_tariff_tiers (plan_id, label, min_lpd, max_lpd, rate_per_m3, sort_order)
SELECT p.id, x.label, x.min_lpd, x.max_lpd, x.rate_per_m3, x.sort_order
FROM public.water_tariff_plans p
CROSS JOIN (VALUES
  ('حتى 50 لتر/فرد/يوم', 0::numeric, 50::numeric, 100::numeric, 10),
  ('من 50 إلى 100 لتر/فرد/يوم', 50::numeric, 100::numeric, 200::numeric, 20),
  ('أكثر من 100 لتر/فرد/يوم', 100::numeric, NULL::numeric, 350::numeric, 30)
) AS x(label,min_lpd,max_lpd,rate_per_m3,sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM public.water_tariff_tiers t WHERE t.plan_id = p.id
);

CREATE OR REPLACE FUNCTION public.update_water_tariff_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS water_tariff_plans_updated_at ON public.water_tariff_plans;
CREATE TRIGGER water_tariff_plans_updated_at
BEFORE UPDATE ON public.water_tariff_plans
FOR EACH ROW EXECUTE FUNCTION public.update_water_tariff_updated_at();

REVOKE ALL ON FUNCTION public.update_water_tariff_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_water_tariff_updated_at() TO service_role;


-- Security-invoker KPI view: the caller's RLS/privileges apply to every source table.
-- IMPORTANT: this view intentionally does NOT label the input-minus-metered-consumption
-- gap as IWA/AWWA/WHO NRW. True NRW requires authorized consumption (including
-- authorized unbilled use) and appropriate apparent/real-loss accounting. Until
-- those components exist in the source model, expose this only as a metered balance gap.
CREATE OR REPLACE VIEW public.monthly_water_service_kpis
WITH (security_invoker = true)
AS
WITH production AS (
  SELECT tenant_id,
         date_trunc('month', recorded_at)::date AS month_start,
         SUM(production_m3) FILTER (WHERE verification_status = 'approved' AND production_m3 > 0) AS system_input_m3
  FROM public.water_production_logs
  WHERE tenant_id = public.current_tenant_id()
  GROUP BY tenant_id, date_trunc('month', recorded_at)
),
readings AS (
  SELECT tenant_id,
         date_trunc('month', created_at)::date AS month_start,
         SUM(consumption) FILTER (WHERE verification_status = 'approved' AND status = 'approved' AND consumption >= 0) AS consumption_m3,
         COUNT(*) AS total_readings,
         COUNT(*) FILTER (WHERE verification_status = 'approved' AND status = 'approved' AND consumption >= 0) AS approved_readings
  FROM public.water_readings
  WHERE tenant_id = public.current_tenant_id()
  GROUP BY tenant_id, date_trunc('month', created_at)
),
billed AS (
  SELECT b.tenant_id,
         date_trunc('month', b.issued_at)::date AS month_start,
         SUM(b.total) AS billed_amount
  FROM public.water_bills b
  JOIN public.water_readings r
    ON r.id = b.reading_id
   AND r.tenant_id = b.tenant_id
   AND r.verification_status = 'approved'
   AND r.status = 'approved'
  WHERE b.tenant_id = public.current_tenant_id()
  GROUP BY b.tenant_id, date_trunc('month', b.issued_at)
),
collected AS (
  SELECT p.tenant_id,
         date_trunc('month', p.created_at)::date AS month_start,
         SUM(p.amount) AS collected_amount
  FROM public.payments p
  JOIN public.water_bills b
    ON b.id = p.bill_id AND b.tenant_id = p.tenant_id
  JOIN public.water_readings r
    ON r.id = b.reading_id
   AND r.tenant_id = b.tenant_id
   AND r.verification_status = 'approved'
   AND r.status = 'approved'
  WHERE p.tenant_id = public.current_tenant_id()
    AND p.status = 'approved'
    AND p.amount >= 0
  GROUP BY p.tenant_id, date_trunc('month', p.created_at)
),
months AS (
  SELECT tenant_id, month_start FROM production
  UNION
  SELECT tenant_id, month_start FROM readings
  UNION
  SELECT tenant_id, month_start FROM billed
  UNION
  SELECT tenant_id, month_start FROM collected
)
SELECT m.tenant_id,
       m.month_start,
       COALESCE(pr.system_input_m3, 0)::numeric AS system_input_m3,
       COALESCE(rd.consumption_m3, 0)::numeric AS consumption_m3,
       CASE
         WHEN COALESCE(pr.system_input_m3, 0) > 0
         THEN (pr.system_input_m3 - COALESCE(rd.consumption_m3, 0))::numeric
         ELSE NULL
       END AS metered_balance_gap_m3,
       CASE
         WHEN COALESCE(pr.system_input_m3, 0) > 0
         THEN ((pr.system_input_m3 - COALESCE(rd.consumption_m3, 0)) / pr.system_input_m3 * 100)::numeric
         ELSE NULL
       END AS metered_balance_gap_pct,
       CASE
         WHEN COALESCE(pr.system_input_m3, 0) > 0
         THEN (COALESCE(rd.consumption_m3, 0) / pr.system_input_m3 * 100)::numeric
         ELSE NULL
       END AS water_efficiency_pct,
       COALESCE(bl.billed_amount, 0)::numeric AS billed_amount,
       COALESCE(co.collected_amount, 0)::numeric AS collected_amount,
       CASE
         WHEN COALESCE(bl.billed_amount, 0) > 0
         THEN (COALESCE(co.collected_amount, 0) / bl.billed_amount * 100)::numeric
         ELSE NULL
       END AS collection_rate_pct,
       COALESCE(rd.approved_readings, 0)::bigint AS approved_readings,
       COALESCE(rd.total_readings, 0)::bigint AS total_readings,
       CASE
         WHEN COALESCE(rd.total_readings, 0) > 0
         THEN (rd.approved_readings::numeric / rd.total_readings * 100)
         ELSE NULL
       END AS approval_rate_pct
FROM months m
LEFT JOIN production pr ON pr.tenant_id = m.tenant_id AND pr.month_start = m.month_start
LEFT JOIN readings rd ON rd.tenant_id = m.tenant_id AND rd.month_start = m.month_start
LEFT JOIN billed bl ON bl.tenant_id = m.tenant_id AND bl.month_start = m.month_start
LEFT JOIN collected co ON co.tenant_id = m.tenant_id AND co.month_start = m.month_start
ORDER BY m.month_start DESC;

REVOKE ALL ON public.monthly_water_service_kpis FROM PUBLIC, anon;
GRANT SELECT ON public.monthly_water_service_kpis TO authenticated;
