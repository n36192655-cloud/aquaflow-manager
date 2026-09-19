-- MIZAN: retire the legacy tenant activation RPC.
-- The original bootstrap migration granted this SECURITY DEFINER function to
-- anon/authenticated. Current owner-scoped provisioning uses create_*_tenant instead.
-- Keep the obsolete RPC unreachable from all runtime roles.

REVOKE ALL ON FUNCTION public.activate_tenant(TEXT,TEXT,INTEGER,INTEGER)
  FROM PUBLIC, anon, authenticated;
