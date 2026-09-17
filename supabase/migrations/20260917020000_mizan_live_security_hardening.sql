-- MIZAN live security hardening.
-- No service-role dependency. Browser clients use authenticated + RLS only.

-- Anonymous clients must not have direct table access to tenant/application data.
REVOKE ALL ON TABLE public.audit_logs, public.billing_cycles, public.customers,
  public.meter_profiles, public.meters, public.payments, public.profiles,
  public.tenants, public.user_roles, public.water_bills,
  public.water_production_logs, public.water_readings
FROM anon;

-- Production logs were previously exposed through policies granted to PUBLIC.
-- Restrict both read and write policy evaluation to authenticated users.
DROP POLICY IF EXISTS "manager write production" ON public.water_production_logs;
DROP POLICY IF EXISTS "tenant read production" ON public.water_production_logs;

CREATE POLICY "manager write production"
ON public.water_production_logs
FOR ALL TO authenticated
USING (
  tenant_id = public.current_tenant_id()
  AND (
    public.has_tenant_role(tenant_id, 'manager'::public.app_role)
    OR public.is_super_admin()
  )
)
WITH CHECK (
  tenant_id = public.current_tenant_id()
  AND (
    public.has_tenant_role(tenant_id, 'manager'::public.app_role)
    OR public.is_super_admin()
  )
);

CREATE POLICY "tenant read production"
ON public.water_production_logs
FOR SELECT TO authenticated
USING (
  tenant_id = public.current_tenant_id()
  OR public.is_super_admin()
);

-- Sensitive workflow mutations must go through authorized transactional RPCs.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.water_readings FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.water_bills FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.payments FROM authenticated;

-- Database-enforceable one-bill-per-reading invariant.
CREATE UNIQUE INDEX IF NOT EXISTS water_bills_reading_id_uidx
  ON public.water_bills(reading_id)
  WHERE reading_id IS NOT NULL;
