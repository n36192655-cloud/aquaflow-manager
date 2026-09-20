-- MIZAN production account lifecycle hardening.
-- Business authorization must not depend on the legacy service_role grant.
-- System-issued initial passwords are temporary and must be replaced by the user.

ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing accounts are already established; only newly provisioned accounts are temporary.
UPDATE public.user_roles
SET must_change_password = FALSE
WHERE must_change_password IS DISTINCT FROM FALSE;

CREATE OR REPLACE FUNCTION public.provision_tenant_user(
  p_actor_user_id UUID,
  p_user_id UUID,
  p_tenant_id UUID,
  p_username TEXT,
  p_display_name TEXT,
  p_role public.app_role
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_username TEXT := lower(trim(p_username));
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL OR p_actor_user_id IS DISTINCT FROM v_actor
     OR NOT public.has_role(v_actor, 'super_admin'::public.app_role) THEN
    RAISE EXCEPTION 'Super-admin permission required';
  END IF;

  IF p_user_id IS NULL OR p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'User and tenant are required';
  END IF;

  IF p_role NOT IN ('manager','collector','reader') THEN
    RAISE EXCEPTION 'Invalid tenant role';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.id = p_tenant_id
      AND t.tenant_type IN ('project','central')
      AND t.subscription_status = 'active'
  ) THEN
    RAISE EXCEPTION 'Tenant is not active';
  END IF;

  IF length(v_username) < 3 OR length(v_username) > 80
     OR v_username !~ '^[a-z0-9][a-z0-9._-]*$' THEN
    RAISE EXCEPTION 'Invalid username';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE lower(p.username) = v_username AND p.id <> p_user_id
  ) THEN
    RAISE EXCEPTION 'Username already exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.tenant_id = p_tenant_id
      AND ur.role = p_role
      AND ur.user_id <> p_user_id
  ) THEN
    RAISE EXCEPTION 'This tenant already has this role';
  END IF;

  UPDATE public.profiles
  SET tenant_id = p_tenant_id,
      username = v_username,
      display_name = trim(p_display_name)
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile was not created by the Auth trigger';
  END IF;

  INSERT INTO public.user_roles(user_id, tenant_id, role, must_change_password)
  VALUES (p_user_id, p_tenant_id, p_role, TRUE)
  ON CONFLICT (user_id, tenant_id, role)
  DO UPDATE SET must_change_password = TRUE;

  INSERT INTO public.audit_logs(tenant_id, user_id, action, entity, entity_id, meta)
  VALUES (
    p_tenant_id,
    v_actor,
    'user.provisioned',
    'auth_user',
    p_user_id::text,
    jsonb_build_object(
      'username', v_username,
      'role', p_role::text,
      'display_name', trim(p_display_name),
      'initial_password_temporary', true
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.provision_tenant_user(UUID,UUID,UUID,TEXT,TEXT,public.app_role)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_tenant_user(UUID,UUID,UUID,TEXT,TEXT,public.app_role)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_initial_password_change()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  UPDATE public.user_roles
  SET must_change_password = FALSE
  WHERE user_id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.complete_initial_password_change() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_initial_password_change() TO authenticated;

-- These business functions execute under their SECURITY DEFINER owner or as
-- authenticated callers; no application code needs a service_role grant.
REVOKE ALL ON FUNCTION public.calculate_water_charge(UUID,UUID,NUMERIC,INTEGER,DATE)
  FROM service_role;
REVOKE ALL ON FUNCTION public.apply_configured_water_tariff() FROM service_role;
REVOKE ALL ON FUNCTION public.update_water_tariff_updated_at() FROM service_role;
