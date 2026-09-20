-- MIZAN authentication rate limiting.
-- Stores only opaque rate-limit keys; never passwords, tokens, emails, or IP addresses.
CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
  rate_key TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_idx
  ON public.auth_rate_limits (updated_at);

ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_auth_rate_limit(
  p_rate_key TEXT,
  p_limit INTEGER,
  p_window_seconds INTEGER DEFAULT 900
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempts INTEGER;
BEGIN
  IF p_rate_key IS NULL OR length(trim(p_rate_key)) < 16 THEN
    RAISE EXCEPTION 'Invalid rate-limit key';
  END IF;
  IF p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'Invalid rate-limit limit';
  END IF;
  IF p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'Invalid rate-limit window';
  END IF;

  INSERT INTO public.auth_rate_limits(rate_key, window_started_at, attempts, updated_at)
  VALUES (p_rate_key, now(), 1, now())
  ON CONFLICT (rate_key) DO UPDATE
  SET
    window_started_at = CASE
      WHEN now() - public.auth_rate_limits.window_started_at >= make_interval(secs => p_window_seconds)
      THEN now()
      ELSE public.auth_rate_limits.window_started_at
    END,
    attempts = CASE
      WHEN now() - public.auth_rate_limits.window_started_at >= make_interval(secs => p_window_seconds)
      THEN 1
      ELSE public.auth_rate_limits.attempts + 1
    END,
    updated_at = now()
  RETURNING attempts INTO v_attempts;

  RETURN v_attempts <= p_limit;
END;
$$;

REVOKE ALL ON TABLE public.auth_rate_limits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_auth_rate_limit(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_auth_rate_limit(TEXT, INTEGER, INTEGER) TO service_role;

-- Remove stale counters opportunistically; the table contains no credential material.
CREATE OR REPLACE FUNCTION public.cleanup_auth_rate_limits()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.auth_rate_limits
  WHERE updated_at < now() - interval '2 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_auth_rate_limits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_auth_rate_limits() TO service_role;
