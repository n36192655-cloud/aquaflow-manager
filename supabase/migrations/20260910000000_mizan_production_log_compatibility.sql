-- MIZAN production-log compatibility schema.
-- The operational workflow references this table before later migrations add
-- verification metadata. Keep the dependency explicit and tenant-scoped.

CREATE TABLE IF NOT EXISTS public.water_production_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  volume NUMERIC CHECK (volume IS NULL OR volume >= 0),
  notes TEXT,
  verification_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS production_tenant_recorded_at_idx
  ON public.water_production_logs(tenant_id, recorded_at DESC);

ALTER TABLE public.water_production_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tenant read production logs" ON public.water_production_logs;
DROP POLICY IF EXISTS "manager write production logs" ON public.water_production_logs;

CREATE POLICY "tenant read production logs"
  ON public.water_production_logs
  FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

CREATE POLICY "manager write production logs"
  ON public.water_production_logs
  FOR ALL TO authenticated
  USING (public.has_tenant_role(tenant_id,'manager') OR public.is_super_admin())
  WITH CHECK (public.has_tenant_role(tenant_id,'manager') OR public.is_super_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.water_production_logs TO authenticated;
GRANT ALL ON public.water_production_logs TO service_role;
