-- Defense-in-depth database privilege hardening.
-- RLS controls row access, but PostgreSQL TRUNCATE, REFERENCES and TRIGGER
-- are table-level privileges and are not appropriate for browser roles.

REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;
