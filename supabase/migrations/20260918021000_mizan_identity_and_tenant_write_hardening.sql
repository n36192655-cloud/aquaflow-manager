-- MIZAN identity and tenant write hardening.
-- Authenticated clients must not directly mutate authorization or tenant-bound identity data.
-- Profile self-update remains available, but tenant_id is immutable for self-service updates.

DROP POLICY IF EXISTS "update own profile" ON public.profiles;

CREATE POLICY "update own profile" ON public.profiles
FOR UPDATE TO authenticated
USING (id = auth.uid())
WITH CHECK (
  id = auth.uid()
  AND tenant_id IS NOT DISTINCT FROM public.current_tenant_id()
);

REVOKE INSERT, DELETE ON public.profiles FROM authenticated;

REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.tenants FROM authenticated;
