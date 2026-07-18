
CREATE OR REPLACE FUNCTION public.activate_tenant(
  _tenant_id text,
  _license_key text,
  _max_seats int,
  _days int DEFAULT 365
)
RETURNS public.tenants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.tenants;
  _uuid uuid;
BEGIN
  -- accept either a uuid or a slug; if not a uuid, deterministically map slug->uuid via md5
  BEGIN
    _uuid := _tenant_id::uuid;
  EXCEPTION WHEN others THEN
    _uuid := ('00000000-0000-0000-0000-' || substr(md5(_tenant_id), 1, 12))::uuid;
  END;

  INSERT INTO public.tenants (id, name, subscription_status, subscription_expires_at)
  VALUES (
    _uuid,
    _tenant_id,
    'active'::subscription_status,
    now() + make_interval(days => COALESCE(_days, 365))
  )
  ON CONFLICT (id) DO UPDATE
    SET subscription_status = 'active'::subscription_status,
        subscription_expires_at = now() + make_interval(days => COALESCE(_days, 365)),
        updated_at = now()
  RETURNING * INTO _row;

  RETURN _row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.activate_tenant(text, text, int, int) TO anon, authenticated;
