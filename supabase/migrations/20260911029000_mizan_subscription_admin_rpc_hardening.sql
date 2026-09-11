-- MIZAN subscription administration hardening
-- No service-role dependency. All privileged subscription mutations require an authenticated super-admin.

CREATE OR REPLACE FUNCTION public.set_tenant_subscription_status(
  p_tenant_id uuid,
  p_status text
)
RETURNS public.tenants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.tenants;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'super-admin authorization required';
  END IF;

  IF p_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'invalid subscription status';
  END IF;

  UPDATE public.tenants
  SET subscription_status = p_status::public.subscription_status,
      updated_at = now()
  WHERE id = p_tenant_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant not found';
  END IF;

  INSERT INTO public.audit_logs (
    tenant_id,
    user_id,
    action,
    entity_type,
    entity_id,
    details
  )
  VALUES (
    v_row.id,
    auth.uid(),
    'subscription_status_changed',
    'tenant',
    v_row.id,
    jsonb_build_object('status', p_status)
  );

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_tenant(
  _tenant_id text,
  _license_key text,
  _max_seats integer,
  _days integer DEFAULT 365
)
RETURNS public.tenants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.tenants;
  v_uuid uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'super-admin authorization required';
  END IF;

  IF btrim(coalesce(_tenant_id, '')) = '' THEN
    RAISE EXCEPTION 'tenant identifier is required';
  END IF;

  IF btrim(coalesce(_license_key, '')) = '' THEN
    RAISE EXCEPTION 'license key is required';
  END IF;

  IF _max_seats IS NULL OR _max_seats < 1 OR _max_seats > 10000 THEN
    RAISE EXCEPTION 'invalid seat count';
  END IF;

  IF _days IS NULL OR _days < 1 OR _days > 3650 THEN
    RAISE EXCEPTION 'invalid license duration';
  END IF;

  BEGIN
    v_uuid := _tenant_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_uuid := ('00000000-0000-0000-0000-' || substr(md5(_tenant_id), 1, 12))::uuid;
  END;

  INSERT INTO public.tenants (
    id,
    name,
    subscription_status,
    subscription_expires_at
  )
  VALUES (
    v_uuid,
    _tenant_id,
    'active'::public.subscription_status,
    now() + make_interval(days => _days)
  )
  ON CONFLICT (id) DO UPDATE
  SET subscription_status = 'active'::public.subscription_status,
      subscription_expires_at = now() + make_interval(days => _days),
      updated_at = now()
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    tenant_id,
    user_id,
    action,
    entity_type,
    entity_id,
    details
  )
  VALUES (
    v_row.id,
    auth.uid(),
    'tenant_activated',
    'tenant',
    v_row.id,
    jsonb_build_object(
      'max_seats', _max_seats,
      'days', _days,
      'license_key_supplied', true
    )
  );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_tenant_subscription_status(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_tenant_subscription_status(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_tenant_subscription_status(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.activate_tenant(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_tenant(text, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.activate_tenant(text, text, integer, integer) TO authenticated;

-- These authorization helper functions are not public API endpoints.
REVOKE ALL ON FUNCTION public.is_super_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_super_admin() FROM anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

REVOKE ALL ON FUNCTION public.has_tenant_role(uuid, public.app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_tenant_role(uuid, public.app_role) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_tenant_role(uuid, public.app_role) TO authenticated;

REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
