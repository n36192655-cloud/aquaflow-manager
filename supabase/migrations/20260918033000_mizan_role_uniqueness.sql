-- Enforce one project account per application role at the database boundary.
-- This closes the concurrency gap between pre-checks and provisioning.
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_project_role_uidx
  ON public.user_roles (tenant_id, role)
  WHERE role IN ('manager', 'collector', 'reader') AND tenant_id IS NOT NULL;
