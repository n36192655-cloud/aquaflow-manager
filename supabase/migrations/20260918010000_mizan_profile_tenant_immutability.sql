-- Prevent authenticated users from moving their own profile between tenants.
-- Tenant membership is server-controlled; self-service profile edits must not alter tenant_id.
DROP POLICY IF EXISTS "update own profile" ON public.profiles;

CREATE POLICY "update own profile" ON public.profiles
FOR UPDATE TO authenticated
USING (
  id = auth.uid()
)
WITH CHECK (
  id = auth.uid()
  AND tenant_id IS NOT DISTINCT FROM public.current_tenant_id()
);
