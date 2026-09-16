-- MIZAN production-log workflow authority.
-- Production records are sensitive operational data: capture -> pending -> manager review -> approved/rejected.
-- Runtime uses authenticated + RLS + SECURITY DEFINER RPCs only; no service-role application path.

ALTER TABLE public.water_production_logs
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_reason TEXT,
  ADD COLUMN IF NOT EXISTS client_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS water_production_logs_tenant_client_id_uidx
  ON public.water_production_logs(tenant_id, client_id)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS water_production_logs_tenant_verification_idx
  ON public.water_production_logs(tenant_id, verification_status, recorded_at DESC);

CREATE OR REPLACE FUNCTION public.record_water_production(
  p_source_name TEXT,
  p_production_m3 NUMERIC,
  p_capture_source TEXT DEFAULT 'field_manual',
  p_note TEXT DEFAULT NULL,
  p_recorded_at TIMESTAMPTZ DEFAULT now(),
  p_client_id TEXT DEFAULT NULL
)
RETURNS TABLE(production_id UUID, verification_status TEXT, client_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_tenant UUID;
  v_existing public.water_production_logs;
  v_client_id TEXT := NULLIF(trim(p_client_id), '');
BEGIN
  SELECT p.tenant_id INTO v_tenant
  FROM public.profiles p
  WHERE p.id = v_uid;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No tenant is assigned to the authenticated user';
  END IF;
  IF NOT (SELECT public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Manager permission required';
  END IF;
  IF COALESCE(length(trim(p_source_name)), 0) < 1 THEN
    RAISE EXCEPTION 'Production source name is required';
  END IF;
  IF p_production_m3 IS NULL OR p_production_m3 <= 0 OR p_production_m3 > 100000000 THEN
    RAISE EXCEPTION 'Production volume is outside the allowed range';
  END IF;
  IF p_recorded_at IS NULL THEN
    RAISE EXCEPTION 'Recorded time is required';
  END IF;

  IF v_client_id IS NOT NULL THEN
    SELECT wpl.* INTO v_existing
    FROM public.water_production_logs wpl
    WHERE wpl.tenant_id = v_tenant AND wpl.client_id = v_client_id
    FOR UPDATE;

    IF v_existing.id IS NOT NULL THEN
      production_id := v_existing.id;
      verification_status := v_existing.verification_status;
      client_id := v_existing.client_id;
      RETURN NEXT;
      RETURN;
    END IF;
  ELSE
    v_client_id := gen_random_uuid()::text;
  END IF;

  INSERT INTO public.water_production_logs(
    tenant_id, source_name, production_m3, recorded_at,
    capture_source, note, created_by, verification_status, client_id
  ) VALUES (
    v_tenant, trim(p_source_name), p_production_m3, p_recorded_at,
    COALESCE(NULLIF(trim(p_capture_source), ''), 'field_manual'),
    NULLIF(trim(p_note), ''), v_uid, 'pending', v_client_id
  )
  RETURNING id, verification_status, client_id
  INTO production_id, verification_status, client_id;

  INSERT INTO public.audit_logs(tenant_id, user_id, action, entity, entity_id, meta)
  VALUES (
    v_tenant, v_uid, 'production_recorded', 'water_production_log', production_id::text,
    jsonb_build_object(
      'source_name', trim(p_source_name),
      'production_m3', p_production_m3,
      'capture_source', COALESCE(NULLIF(trim(p_capture_source), ''), 'field_manual'),
      'client_id', v_client_id
    )
  );

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_water_production(p_production_id UUID)
RETURNS TABLE(production_id UUID, verification_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_tenant UUID;
  v_row public.water_production_logs;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = v_uid;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No tenant is assigned to the authenticated user';
  END IF;
  IF NOT (SELECT public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Manager permission required';
  END IF;

  SELECT wpl.* INTO v_row
  FROM public.water_production_logs wpl
  WHERE wpl.id = p_production_id AND wpl.tenant_id = v_tenant
  FOR UPDATE;

  IF v_row.id IS NULL OR v_row.verification_status <> 'pending' THEN
    RAISE EXCEPTION 'Production record not found or is not pending';
  END IF;

  UPDATE public.water_production_logs
  SET verification_status = 'approved',
      verified_by = v_uid,
      verified_at = now(),
      review_reason = NULL,
      updated_at = now()
  WHERE id = p_production_id AND tenant_id = v_tenant AND verification_status = 'pending';

  INSERT INTO public.audit_logs(tenant_id, user_id, action, entity, entity_id, meta)
  VALUES (
    v_tenant, v_uid, 'production_approved', 'water_production_log', p_production_id::text,
    jsonb_build_object('production_m3', v_row.production_m3, 'source_name', v_row.source_name)
  );

  production_id := p_production_id;
  verification_status := 'approved';
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_water_production(p_production_id UUID, p_reason TEXT)
RETURNS TABLE(production_id UUID, verification_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := (SELECT auth.uid());
  v_tenant UUID;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = v_uid;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No tenant is assigned to the authenticated user';
  END IF;
  IF NOT (SELECT public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Manager permission required';
  END IF;
  IF COALESCE(length(trim(p_reason)), 0) < 3 THEN
    RAISE EXCEPTION 'Rejection reason is required';
  END IF;

  UPDATE public.water_production_logs
  SET verification_status = 'rejected',
      verified_by = v_uid,
      verified_at = now(),
      review_reason = trim(p_reason),
      updated_at = now()
  WHERE id = p_production_id
    AND tenant_id = v_tenant
    AND verification_status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Production record not found or is not pending';
  END IF;

  INSERT INTO public.audit_logs(tenant_id, user_id, action, entity, entity_id, meta)
  VALUES (
    v_tenant, v_uid, 'production_rejected', 'water_production_log', p_production_id::text,
    jsonb_build_object('reason', trim(p_reason))
  );

  production_id := p_production_id;
  verification_status := 'rejected';
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.record_water_production(TEXT,NUMERIC,TEXT,TEXT,TIMESTAMPTZ,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_water_production(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_water_production(UUID,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_water_production(TEXT,NUMERIC,TEXT,TEXT,TIMESTAMPTZ,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_water_production(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_water_production(UUID,TEXT) TO authenticated;

-- Prevent bypass of the production review workflow through direct table writes.
REVOKE INSERT, UPDATE, DELETE ON public.water_production_logs FROM authenticated;
GRANT SELECT ON public.water_production_logs TO authenticated;
