-- Ensure authenticated users can only read tenants they are entitled to see.
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_select_accessible ON public.tenants;
CREATE POLICY tenants_select_accessible
ON public.tenants
FOR SELECT
TO authenticated
USING (public.can_access_tenant(id));
