-- Defense-in-depth hardening for PostgREST/Supabase API roles.
-- RLS remains the primary row-level authorization layer. This migration removes
-- table privileges that RLS cannot safely constrain (TRUNCATE/TRIGGER/REFERENCES)
-- and removes all direct table privileges from anon so unauthenticated clients
-- cannot reach application tables at all.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT format('%I.%I', n.nspname, c.relname) AS qualified_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM anon', r.qualified_name);
    EXECUTE format('REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE %s FROM authenticated', r.qualified_name);
    EXECUTE format('REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE %s FROM anon', r.qualified_name);
  END LOOP;
END
$$;

-- Policies on production logs must never be exposed to the public role.
DROP POLICY IF EXISTS "manager write production" ON public.water_production_logs;
DROP POLICY IF EXISTS "tenant read production" ON public.water_production_logs;

CREATE POLICY "manager write production" ON public.water_production_logs
FOR ALL TO authenticated
USING (
  has_tenant_role(tenant_id, 'manager'::app_role)
  OR is_super_admin()
)
WITH CHECK (
  tenant_id = current_tenant_id()
  AND (
    has_tenant_role(tenant_id, 'manager'::app_role)
    OR is_super_admin()
  )
);

CREATE POLICY "tenant read production" ON public.water_production_logs
FOR SELECT TO authenticated
USING (
  tenant_id = current_tenant_id()
  OR is_super_admin()
);
