-- MIZAN username login without a service-role application path.
-- Supabase Auth remains the password authority; username is only the user-facing identifier.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_uidx
  ON public.profiles (lower(username))
  WHERE username IS NOT NULL;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_username_format;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_username_format
  CHECK (username IS NULL OR username ~ '^[A-Za-z0-9._-]{3,40}$');

-- Resolve the internal Supabase Auth email for a username. The real email is
-- never rendered by the application; it is used only for signInWithPassword.
-- This RPC deliberately returns no row for an unknown username.
CREATE OR REPLACE FUNCTION public.resolve_login_email(p_username TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, auth
AS $$
DECLARE
  v_email TEXT;
BEGIN
  SELECT u.email INTO v_email
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE lower(p.username) = lower(trim(p_username))
    AND u.email IS NOT NULL
  LIMIT 1;
  RETURN v_email;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_login_email(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_login_email(TEXT) TO anon, authenticated;

COMMENT ON COLUMN public.profiles.username IS 'Unique user-facing Mizan login name; Supabase Auth remains the credential authority.';
COMMENT ON FUNCTION public.resolve_login_email(TEXT) IS 'Maps a Mizan username to its internal Supabase Auth email for password authentication.';
