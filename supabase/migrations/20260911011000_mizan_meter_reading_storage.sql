-- Private meter-reading image storage for online/offline field capture.
-- Images are tenant-scoped through object path and authenticated access policies.
INSERT INTO storage.buckets (id, name, public)
VALUES ('meter-readings', 'meter-readings', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "meter reading images select" ON storage.objects;
DROP POLICY IF EXISTS "meter reading images insert" ON storage.objects;
DROP POLICY IF EXISTS "meter reading images update" ON storage.objects;

CREATE POLICY "meter reading images select" ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
);

CREATE POLICY "meter reading images insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
);

CREATE POLICY "meter reading images update" ON storage.objects
FOR UPDATE TO authenticated
USING (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
)
WITH CHECK (
  bucket_id = 'meter-readings'
  AND (storage.foldername(name))[1] = (SELECT public.current_tenant_id())::text
);
