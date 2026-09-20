-- MIZAN central tenant dashboard: read-only aggregate view across child projects.
-- Central managers can monitor their child projects without switching tenant context.
CREATE OR REPLACE FUNCTION public.central_dashboard_project_metrics(
  p_days INTEGER DEFAULT 30
)
RETURNS TABLE(
  tenant_id UUID,
  project_name TEXT,
  subscription_status TEXT,
  active_customers BIGINT,
  total_readings BIGINT,
  approved_readings BIGINT,
  pending_readings BIGINT,
  rejected_readings BIGINT,
  approved_consumption_m3 NUMERIC,
  production_input_m3 NUMERIC,
  water_efficiency_pct NUMERIC,
  metered_balance_gap_pct NUMERIC,
  billed_amount NUMERIC,
  collected_amount NUMERIC,
  collection_rate_pct NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_current_tenant UUID := public.current_tenant_id();
  v_days INTEGER := LEAST(GREATEST(COALESCE(p_days, 30), 1), 366);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  IF NOT public.is_super_admin() THEN
    IF v_current_tenant IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM public.tenants t
         WHERE t.id = v_current_tenant
           AND t.tenant_type = 'central'
       )
       OR NOT public.has_tenant_role(v_current_tenant, 'manager'::public.app_role)
    THEN
      RAISE EXCEPTION 'Central manager permission required';
    END IF;
  END IF;

  RETURN QUERY
  WITH project_scope AS (
    SELECT t.id, t.name, t.project_name, t.subscription_status
    FROM public.tenants t
    WHERE t.tenant_type = 'project'
      AND (
        public.is_super_admin()
        OR t.parent_tenant_id = v_current_tenant
      )
  ),
  bounds AS (
    SELECT now() - make_interval(days => v_days) AS start_at, now() AS end_at
  ),
  reading_stats AS (
    SELECT
      r.tenant_id,
      COUNT(*)::bigint AS total_readings,
      COUNT(*) FILTER (
        WHERE r.verification_status = 'approved'
          AND r.status = 'approved'
          AND r.consumption >= 0
      )::bigint AS approved_readings,
      COUNT(*) FILTER (WHERE r.verification_status = 'pending')::bigint AS pending_readings,
      COUNT(*) FILTER (WHERE r.verification_status = 'rejected')::bigint AS rejected_readings,
      COALESCE(SUM(r.consumption) FILTER (
        WHERE r.verification_status = 'approved'
          AND r.status = 'approved'
          AND r.consumption >= 0
      ), 0)::numeric AS approved_consumption_m3
    FROM public.water_readings r
    CROSS JOIN bounds b
    WHERE r.created_at >= b.start_at
      AND r.created_at < b.end_at
    GROUP BY r.tenant_id
  ),
  production_stats AS (
    SELECT
      p.tenant_id,
      COALESCE(SUM(p.production_m3) FILTER (
        WHERE p.verification_status = 'approved'
          AND p.production_m3 > 0
      ), 0)::numeric AS production_input_m3
    FROM public.water_production_logs p
    CROSS JOIN bounds b
    WHERE p.recorded_at >= b.start_at
      AND p.recorded_at < b.end_at
    GROUP BY p.tenant_id
  ),
  bill_stats AS (
    SELECT
      b.tenant_id,
      COALESCE(SUM(b.total) FILTER (
        WHERE b.total >= 0
          AND b.reading_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.water_readings r
            WHERE r.id = b.reading_id
              AND r.tenant_id = b.tenant_id
              AND r.verification_status = 'approved'
              AND r.status = 'approved'
              AND r.consumption >= 0
          )
      ), 0)::numeric AS billed_amount
    FROM public.water_bills b
    CROSS JOIN bounds bd
    WHERE b.issued_at >= bd.start_at
      AND b.issued_at < bd.end_at
    GROUP BY b.tenant_id
  ),
  payment_stats AS (
    SELECT
      p.tenant_id,
      COALESCE(SUM(p.amount) FILTER (
        WHERE p.status = 'approved'
          AND p.amount >= 0
          AND EXISTS (
            SELECT 1
            FROM public.water_bills b
            JOIN public.water_readings r
              ON r.id = b.reading_id
             AND r.tenant_id = b.tenant_id
            WHERE b.id = p.bill_id
              AND b.tenant_id = p.tenant_id
              AND r.verification_status = 'approved'
              AND r.status = 'approved'
              AND r.consumption >= 0
          )
      ), 0)::numeric AS collected_amount
    FROM public.payments p
    CROSS JOIN bounds bd
    WHERE p.created_at >= bd.start_at
      AND p.created_at < bd.end_at
    GROUP BY p.tenant_id
  ),
  customer_stats AS (
    SELECT c.tenant_id, COUNT(*)::bigint AS active_customers
    FROM public.customers c
    WHERE c.status = 'active'
    GROUP BY c.tenant_id
  )
  SELECT
    s.id,
    COALESCE(s.project_name, s.name),
    s.subscription_status,
    COALESCE(cs.active_customers, 0),
    COALESCE(rs.total_readings, 0),
    COALESCE(rs.approved_readings, 0),
    COALESCE(rs.pending_readings, 0),
    COALESCE(rs.rejected_readings, 0),
    COALESCE(rs.approved_consumption_m3, 0),
    NULLIF(COALESCE(ps.production_input_m3, 0), 0),
    CASE
      WHEN COALESCE(ps.production_input_m3, 0) > 0
      THEN (COALESCE(rs.approved_consumption_m3, 0) / ps.production_input_m3 * 100)::numeric
      ELSE NULL
    END,
    CASE
      WHEN COALESCE(ps.production_input_m3, 0) > 0
      THEN ((ps.production_input_m3 - COALESCE(rs.approved_consumption_m3, 0)) / ps.production_input_m3 * 100)::numeric
      ELSE NULL
    END,
    COALESCE(bs.billed_amount, 0),
    COALESCE(pay.collected_amount, 0),
    CASE
      WHEN COALESCE(bs.billed_amount, 0) > 0
      THEN (COALESCE(pay.collected_amount, 0) / bs.billed_amount * 100)::numeric
      ELSE NULL
    END
  FROM project_scope s
  LEFT JOIN customer_stats cs ON cs.tenant_id = s.id
  LEFT JOIN reading_stats rs ON rs.tenant_id = s.id
  LEFT JOIN production_stats ps ON ps.tenant_id = s.id
  LEFT JOIN bill_stats bs ON bs.tenant_id = s.id
  LEFT JOIN payment_stats pay ON pay.tenant_id = s.id
  ORDER BY COALESCE(s.project_name, s.name);
$$;

REVOKE ALL ON FUNCTION public.central_dashboard_project_metrics(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.central_dashboard_project_metrics(INTEGER) TO authenticated;
