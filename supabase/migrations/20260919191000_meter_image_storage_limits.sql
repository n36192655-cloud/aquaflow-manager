-- Constrain field meter-reading uploads at the storage layer as well as in the client.
UPDATE storage.buckets
SET file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp']::text[]
WHERE id = 'meter-readings';
