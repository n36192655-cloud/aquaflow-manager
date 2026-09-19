-- MIZAN billing consistency hardening.
-- Re-run the configured tariff calculation when an existing bill is revised.
-- This closes the legacy-bill path where tariff metadata could remain stale/null.
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
    GREATEST(
      1,
      COALESCE(
        EXTRACT(DAY FROM (NEW.issued_at::date - lagged.issued_date))::INTEGER,
        30
      )
    ),
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
    RAISE EXCEPTION 'Cannot calculate tariff for bill reading';
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

DROP TRIGGER IF EXISTS water_bills_configured_tariff_bu ON public.water_bills;
CREATE TRIGGER water_bills_configured_tariff_bu
BEFORE UPDATE OF reading_id, customer_id, issued_at, subtotal, arrears, total
ON public.water_bills
FOR EACH ROW
EXECUTE FUNCTION public.apply_configured_water_tariff();

REVOKE ALL ON FUNCTION public.apply_configured_water_tariff() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_configured_water_tariff() TO service_role;

-- Keep billing math internally consistent even when rows are created by other
-- trusted server-side paths. Existing rows are not rewritten by this migration.
CREATE OR REPLACE FUNCTION public.validate_water_bill_financial_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.subtotal < 0 OR NEW.arrears < 0 OR NEW.total < 0 THEN
    RAISE EXCEPTION 'Invalid negative bill amount';
  END IF;

  IF NEW.total <> NEW.subtotal + NEW.arrears THEN
    RAISE EXCEPTION 'Bill total must equal subtotal plus arrears';
  END IF;

  IF NEW.reading_id IS NOT NULL AND (
    NEW.customer_id IS NULL OR NEW.tenant_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Reading-linked bill requires tenant and customer';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS water_bills_financial_integrity_biu ON public.water_bills;
CREATE TRIGGER water_bills_financial_integrity_biu
BEFORE INSERT OR UPDATE ON public.water_bills
FOR EACH ROW
EXECUTE FUNCTION public.validate_water_bill_financial_integrity();

REVOKE ALL ON FUNCTION public.validate_water_bill_financial_integrity() FROM PUBLIC, anon, authenticated;
