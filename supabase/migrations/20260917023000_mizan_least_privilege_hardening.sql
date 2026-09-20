-- Defense-in-depth hardening for PostgREST/Supabase API roles.
-- No service-role dependency. Browser clients use publishable access + Auth + RLS.

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
    -- Anonymous browser clients must not reach application tables directly.
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM anon', r.qualified_name);
    -- RLS cannot constrain these table-level capabilities, so remove them.
    EXECUTE format('REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE %s FROM authenticated', r.qualified_name);
    EXECUTE format('REVOKE REFERENCES, TRIGGER, TRUNCATE ON TABLE %s FROM anon', r.qualified_name);
  END LOOP;
END
$$;

-- Sensitive workflow mutations are RPC-only. The RPCs perform authorization,
-- validation, transaction handling and idempotency checks server-side.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.water_readings FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.water_bills FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.payments FROM authenticated;

-- Production logs must never be exposed through the PUBLIC role.
DROP POLICY IF EXISTS "manager write production" ON public.water_production_logs;
DROP POLICY IF EXISTS "tenant read production" ON public.water_production_logs;

CREATE POLICY "manager write production" ON public.water_production_logs
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

CREATE POLICY "tenant read production" ON public.water_production_logs
FOR SELECT TO authenticated
USING (
  tenant_id = public.current_tenant_id()
  OR public.is_super_admin()
);

-- A reading can produce at most one bill; enforce this at database level.
CREATE UNIQUE INDEX IF NOT EXISTS water_bills_reading_id_uidx
  ON public.water_bills(reading_id)
  WHERE reading_id IS NOT NULL;
