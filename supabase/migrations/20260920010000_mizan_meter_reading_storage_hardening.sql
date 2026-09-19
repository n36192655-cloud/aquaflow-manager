-- MIZAN meter-reading storage hardening.
-- Tenant users may only upload/manage their own reading images.
-- Managers and platform owners may review images inside their authorized tenant.
-- No service-role path is introduced.

DROP POLICY IF EXISTS "meter reading images select" ON storage.objects;
DROP POLICY IF EXISTS "meter reading images insert" ON storage.objects;
DROP POLICY IF EXISTS "meter reading images update" ON storage.objects;
DROP POLICY IF EXISTS "meter reading images delete" ON storage.objects;

CREATE POLICY "meter reading images select"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
  AND (
    (storage.foldername(name))[2] = (SELECT auth.uid())::text
    OR (SELECT public.has_tenant_role(public.current_tenant_id(), 'manager'))
    OR (SELECT public.is_super_admin())
  )
);

CREATE POLICY "meter reading images insert"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
  AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
);

CREATE POLICY "meter reading images update"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
  AND (
    (storage.foldername(name))[2] = (SELECT auth.uid())::text
    OR (SELECT public.has_tenant_role(public.current_tenant_id(), 'manager'))
    OR (SELECT public.is_super_admin())
  )
)
WITH CHECK (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
  AND (
    (storage.foldername(name))[2] = (SELECT auth.uid())::text
    OR (SELECT public.has_tenant_role(public.current_tenant_id(), 'manager'))
    OR (SELECT public.is_super_admin())
  )
);

CREATE POLICY "meter reading images delete"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
  AND (
    (storage.foldername(name))[2] = (SELECT auth.uid())::text
    OR (SELECT public.has_tenant_role(public.current_tenant_id(), 'manager'))
    OR (SELECT public.is_super_admin())
  )
);
