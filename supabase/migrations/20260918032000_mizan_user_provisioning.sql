-- MIZAN user provisioning and username identity.
-- Passwords remain exclusively in Supabase Auth. No plaintext password or token is stored.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_uidx
  ON public.profiles (lower(username))
  WHERE username IS NOT NULL;

UPDATE public.profiles p
SET username = lower(split_part(u.email, '@', 1))
FROM auth.users u
WHERE u.id = p.id
  AND p.username IS NULL
  AND u.email IS NOT NULL
  AND u.email <> '';

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
BEGIN
  IF p_actor_user_id IS NULL OR NOT public.has_role(p_actor_user_id, 'super_admin') THEN
    RAISE EXCEPTION 'Super-admin permission required';
  END IF;
  IF p_user_id IS NULL OR p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'User and tenant are required';
  END IF;
  IF p_role NOT IN ('manager','collector','reader') THEN
    RAISE EXCEPTION 'Invalid project role';
  END IF;
  IF length(v_username) < 3 OR length(v_username) > 80 OR v_username !~ '^[a-z0-9][a-z0-9._-]*$' THEN
    RAISE EXCEPTION 'Invalid username';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tenants t
    WHERE t.id = p_tenant_id
      AND t.tenant_type = 'project'
      AND t.subscription_status = 'active'
  ) THEN
    RAISE EXCEPTION 'Project tenant is not active';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE lower(p.username) = v_username AND p.id <> p_user_id
  ) THEN
    RAISE EXCEPTION 'Username already exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.tenant_id = p_tenant_id AND ur.role = p_role AND ur.user_id <> p_user_id
  ) THEN
    RAISE EXCEPTION 'This project already has this role';
  END IF;

  UPDATE public.profiles
  SET tenant_id = p_tenant_id,
      username = v_username,
      display_name = trim(p_display_name)
  WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile was not created by the Auth trigger';
  END IF;

  INSERT INTO public.user_roles(user_id, tenant_id, role)
  VALUES (p_user_id, p_tenant_id, p_role)
  ON CONFLICT (user_id, tenant_id, role) DO NOTHING;

  INSERT INTO public.audit_logs(tenant_id, user_id, action, entity, entity_id, meta)
  VALUES (
    p_tenant_id,
    p_actor_user_id,
    'user.provisioned',
    'auth_user',
    p_user_id::text,
    jsonb_build_object('username', v_username, 'role', p_role::text, 'display_name', trim(p_display_name))
  );
END;
$$;

REVOKE ALL ON FUNCTION public.provision_tenant_user(UUID,UUID,UUID,TEXT,TEXT,public.app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.provision_tenant_user(UUID,UUID,UUID,TEXT,TEXT,public.app_role) FROM anon;
REVOKE ALL ON FUNCTION public.provision_tenant_user(UUID,UUID,UUID,TEXT,TEXT,public.app_role) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.provision_tenant_user(UUID,UUID,UUID,TEXT,TEXT,public.app_role) TO service_role;
