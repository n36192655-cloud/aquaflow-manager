-- Harden meter-reading object paths against client-side path tampering.
-- The first path segment is tenant-scoped; the second must be the authenticated user
-- for writes/deletes. Tenant-scoped SELECT remains available for authorized reviewers.

DROP POLICY IF EXISTS "meter reading images insert" ON storage.objects;
DROP POLICY IF EXISTS "meter reading images update" ON storage.objects;
DROP POLICY IF EXISTS "meter reading images delete" ON storage.objects;

CREATE POLICY "meter reading images insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
  AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
);

CREATE POLICY "meter reading images update" ON storage.objects
FOR UPDATE TO authenticated
USING (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
  AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
)
WITH CHECK (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
  AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
);

CREATE POLICY "meter reading images delete" ON storage.objects
FOR DELETE TO authenticated
USING (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
  AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
);
