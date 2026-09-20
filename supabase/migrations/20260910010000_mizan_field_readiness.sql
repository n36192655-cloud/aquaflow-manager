-- MIZAN field-readiness hardening. Uses authenticated + RLS only; no service-role path.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS project_name TEXT;

UPDATE public.tenants
SET project_name = 'مشروع مياه المسراخ'
WHERE name IN ('مشروع مياه مركز المسراخ', 'مشروع مياه المسراخ')
  AND (project_name IS NULL OR project_name = '');

CREATE TABLE IF NOT EXISTS public.meter_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_type TEXT NOT NULL CHECK (display_type IN ('digital','mechanical','analog','circular','hybrid')),
  integer_digits SMALLINT NOT NULL DEFAULT 0 CHECK (integer_digits >= 0 AND integer_digits <= 12),
  decimal_digits SMALLINT NOT NULL DEFAULT 0 CHECK (decimal_digits >= 0 AND decimal_digits <= 6),
  register_order TEXT NOT NULL DEFAULT 'integer_then_decimal',
  color_semantics JSONB NOT NULL DEFAULT '{}'::jsonb,
  unit TEXT NOT NULL DEFAULT 'm3',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS public.meters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  profile_id UUID REFERENCES public.meter_profiles(id) ON DELETE SET NULL,
  serial_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','pending')),
  installed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, serial_number)
);
CREATE INDEX IF NOT EXISTS meters_tenant_customer_idx ON public.meters(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS meters_tenant_serial_idx ON public.meters(tenant_id, serial_number);

ALTER TABLE public.water_readings
  ADD COLUMN IF NOT EXISTS meter_id UUID REFERENCES public.meters(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS capture_source TEXT NOT NULL DEFAULT 'manual' CHECK (capture_source IN ('camera','phone','manual','offline')),
  ADD COLUMN IF NOT EXISTS ocr_confidence NUMERIC CHECK (ocr_confidence IS NULL OR (ocr_confidence >= 0 AND ocr_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS ocr_raw_text TEXT,
  ADD COLUMN IF NOT EXISTS identity_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reading_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_reason TEXT,
  ADD COLUMN IF NOT EXISTS client_id TEXT,
  ADD COLUMN IF NOT EXISTS source_device TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS water_readings_client_id_uidx
  ON public.water_readings(tenant_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS water_readings_tenant_meter_date_idx ON public.water_readings(tenant_id, meter_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.billing_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  cycle_key TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cycle_key),
  CHECK (ends_at > starts_at)
);

ALTER TABLE public.water_bills
  ADD COLUMN IF NOT EXISTS cycle_id UUID REFERENCES public.billing_cycles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS project_name TEXT,
  ADD COLUMN IF NOT EXISTS client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS water_bills_client_id_uidx
  ON public.water_bills(tenant_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS water_bills_tenant_cycle_idx ON public.water_bills(tenant_id, cycle_id, issued_at DESC);

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payments_client_id_uidx
  ON public.payments(tenant_id, client_id) WHERE client_id IS NOT NULL;

ALTER TABLE public.meter_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_cycles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant read meter profiles" ON public.meter_profiles;
DROP POLICY IF EXISTS "manager write meter profiles" ON public.meter_profiles;
CREATE POLICY "tenant read meter profiles" ON public.meter_profiles FOR SELECT TO authenticated
  USING (tenant_id = (SELECT public.current_tenant_id()) OR (SELECT public.is_super_admin()));
CREATE POLICY "manager write meter profiles" ON public.meter_profiles FOR ALL TO authenticated
  USING ((SELECT public.has_tenant_role(tenant_id,'manager')) OR (SELECT public.is_super_admin()))
  WITH CHECK ((SELECT public.has_tenant_role(tenant_id,'manager')) OR (SELECT public.is_super_admin()));

DROP POLICY IF EXISTS "tenant read meters" ON public.meters;
DROP POLICY IF EXISTS "manager write meters" ON public.meters;
CREATE POLICY "tenant read meters" ON public.meters FOR SELECT TO authenticated
  USING (tenant_id = (SELECT public.current_tenant_id()) OR (SELECT public.is_super_admin()));
CREATE POLICY "manager write meters" ON public.meters FOR ALL TO authenticated
  USING ((SELECT public.has_tenant_role(tenant_id,'manager')) OR (SELECT public.is_super_admin()))
  WITH CHECK ((SELECT public.has_tenant_role(tenant_id,'manager')) OR (SELECT public.is_super_admin()));

DROP POLICY IF EXISTS "tenant read billing cycles" ON public.billing_cycles;
DROP POLICY IF EXISTS "manager write billing cycles" ON public.billing_cycles;
CREATE POLICY "tenant read billing cycles" ON public.billing_cycles FOR SELECT TO authenticated
  USING (tenant_id = (SELECT public.current_tenant_id()) OR (SELECT public.is_super_admin()));
CREATE POLICY "manager write billing cycles" ON public.billing_cycles FOR ALL TO authenticated
  USING ((SELECT public.has_tenant_role(tenant_id,'manager')) OR (SELECT public.is_super_admin()))
  WITH CHECK ((SELECT public.has_tenant_role(tenant_id,'manager')) OR (SELECT public.is_super_admin()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.meter_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.meters TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_cycles TO authenticated;

-- Server-authoritative water tariff used by the reading->bill transaction.
CREATE OR REPLACE FUNCTION public.water_charge(p_units NUMERIC)
RETURNS NUMERIC
LANGUAGE SQL IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_units <= 0 THEN 0
    ELSE LEAST(p_units,10) * 100
       + GREATEST(LEAST(p_units-10,20),0) * 200
       + GREATEST(LEAST(p_units-30,70),0) * 350
       + GREATEST(p_units-100,0) * 350
  END;
$$;

CREATE OR REPLACE FUNCTION public.current_billing_cycle(p_tenant UUID, p_at TIMESTAMPTZ DEFAULT now())
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_start TIMESTAMPTZ := date_trunc('month', p_at);
  v_end TIMESTAMPTZ := v_start + interval '1 month';
  v_key TEXT := to_char(v_start, 'YYYY-MM');
  v_id UUID;
BEGIN
  INSERT INTO public.billing_cycles(tenant_id, cycle_key, starts_at, ends_at, status)
  VALUES (p_tenant, v_key, v_start, v_end, 'open')
  ON CONFLICT (tenant_id, cycle_key) DO UPDATE SET status = public.billing_cycles.status
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.current_billing_cycle(UUID,TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_billing_cycle(UUID,TIMESTAMPTZ) TO authenticated;

-- Atomic, idempotent online/offline-safe reading + invoice creation.
CREATE OR REPLACE FUNCTION public.record_water_reading(
  p_meter_id UUID,
  p_current NUMERIC,
  p_photo_url TEXT DEFAULT NULL,
  p_capture_source TEXT DEFAULT 'manual',
  p_ocr_serial TEXT DEFAULT NULL,
  p_ocr_confidence NUMERIC DEFAULT NULL,
  p_ocr_raw_text TEXT DEFAULT NULL,
  p_client_id TEXT DEFAULT NULL,
  p_lat NUMERIC DEFAULT NULL,
  p_lng NUMERIC DEFAULT NULL,
  p_accuracy NUMERIC DEFAULT NULL
)
RETURNS TABLE(reading_id UUID, bill_id UUID, previous NUMERIC, current_reading NUMERIC, consumption NUMERIC, bill_total NUMERIC, arrears NUMERIC, project_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_tenant UUID;
  v_customer UUID;
  v_serial TEXT;
  v_prev NUMERIC;
  v_consumption NUMERIC;
  v_subtotal NUMERIC;
  v_arrears NUMERIC;
  v_cycle UUID;
  v_project TEXT;
  v_reading UUID;
  v_bill UUID;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No tenant is assigned to the authenticated user'; END IF;
  IF NOT (SELECT public.has_tenant_role(v_tenant,'reader') OR public.has_tenant_role(v_tenant,'manager')) THEN
    RAISE EXCEPTION 'Insufficient permission to record readings';
  END IF;

  SELECT m.customer_id, m.serial_number INTO v_customer, v_serial
  FROM public.meters m WHERE m.id = p_meter_id AND m.tenant_id = v_tenant AND m.status = 'active';
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Meter is not active or is not assigned to this tenant'; END IF;
  IF p_ocr_serial IS NOT NULL AND regexp_replace(upper(p_ocr_serial), '[^A-Z0-9]', '', 'g') <> regexp_replace(upper(v_serial), '[^A-Z0-9]', '', 'g') THEN
    RAISE EXCEPTION 'Meter identity mismatch';
  END IF;

  IF p_client_id IS NOT NULL THEN
    SELECT wr.id INTO v_reading FROM public.water_readings wr WHERE wr.tenant_id = v_tenant AND wr.client_id = p_client_id;
    IF v_reading IS NOT NULL THEN
      SELECT wb.id, wr.previous, wr.current_reading, wr.consumption, wb.total, wb.arrears, COALESCE(wb.project_name,t.project_name,t.name)
      INTO v_bill, previous, current_reading, consumption, bill_total, arrears, project_name
      FROM public.water_readings wr
      LEFT JOIN public.water_bills wb ON wb.reading_id = wr.id
      JOIN public.tenants t ON t.id = wr.tenant_id
      WHERE wr.id = v_reading;
      reading_id := v_reading; bill_id := v_bill; RETURN NEXT; RETURN;
    END IF;
  END IF;

  SELECT wr.current_reading INTO v_prev
  FROM public.water_readings wr
  WHERE wr.tenant_id = v_tenant AND wr.meter_id = p_meter_id AND wr.status = 'approved'
  ORDER BY wr.created_at DESC LIMIT 1;
  v_prev := COALESCE(v_prev, 0);
  IF p_current < v_prev THEN RAISE EXCEPTION 'Current reading cannot be lower than previous approved reading'; END IF;
  v_consumption := p_current - v_prev;
  v_subtotal := public.water_charge(v_consumption);
  SELECT COALESCE(SUM(GREATEST(wb.total - COALESCE((SELECT SUM(pp.amount) FROM public.payments pp WHERE pp.bill_id=wb.id AND pp.status='approved'),0),0)),0)
  INTO v_arrears FROM public.water_bills wb
  WHERE wb.tenant_id = v_tenant AND wb.customer_id = v_customer AND wb.status <> 'paid';
  SELECT t.project_name, t.name INTO v_project, project_name FROM public.tenants t WHERE t.id = v_tenant;
  v_project := COALESCE(v_project, project_name, 'مشروع مياه المسراخ');
  v_cycle := public.current_billing_cycle(v_tenant, now());

  INSERT INTO public.water_readings(tenant_id, customer_id, meter_number, meter_id, previous, current_reading, consumption, photo_url, lat, lng, flag, status, reader_id, capture_source, ocr_serial, ocr_confidence, ocr_raw_text, identity_verified, reading_verified, client_id)
  VALUES (v_tenant, v_customer, v_serial, p_meter_id, v_prev, p_current, v_consumption, p_photo_url, p_lat, p_lng, 'ok', 'approved', v_uid, p_capture_source, p_ocr_serial, p_ocr_confidence, p_ocr_raw_text, true, true, p_client_id)
  RETURNING id INTO v_reading;

  INSERT INTO public.water_bills(tenant_id, customer_id, reading_id, subtotal, arrears, total, status, cycle_id, project_name, client_id)
  VALUES (v_tenant, v_customer, v_reading, v_subtotal, v_arrears, v_subtotal + v_arrears, 'unpaid', v_cycle, v_project, p_client_id)
  RETURNING id INTO v_bill;

  reading_id := v_reading; bill_id := v_bill; previous := v_prev; current_reading := p_current; consumption := v_consumption; bill_total := v_subtotal + v_arrears; arrears := v_arrears; project_name := v_project; RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.record_water_reading(UUID,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,NUMERIC,NUMERIC,NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_water_reading(UUID,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,NUMERIC,NUMERIC,NUMERIC) TO authenticated;

-- Keep the project label authoritative for the requested water project.
UPDATE public.tenants SET project_name = 'مشروع مياه المسراخ' WHERE name = 'مشروع مياه مركز المسراخ';
