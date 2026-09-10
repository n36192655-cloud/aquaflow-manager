-- MIZAN payment idempotency race hardening.
-- A unique constraint prevents duplicate client ids, but concurrent requests
-- must also return the already-created payment instead of surfacing a raw
-- unique-violation error to the collector.

CREATE OR REPLACE FUNCTION public.record_water_payment(
  p_bill_id UUID,
  p_amount NUMERIC,
  p_method TEXT DEFAULT 'cash',
  p_client_id TEXT DEFAULT NULL
)
RETURNS TABLE(payment_id UUID, bill_id UUID, amount NUMERIC, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tenant UUID;
  v_payment UUID;
  v_total NUMERIC;
  v_paid NUMERIC;
  v_outstanding NUMERIC;
  v_reading UUID;
  v_verification TEXT;
  v_client_id TEXT := NULLIF(trim(p_client_id), '');
BEGIN
  SELECT p.tenant_id INTO v_tenant
  FROM public.profiles p
  WHERE p.id = v_uid;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No tenant is assigned to the authenticated user';
  END IF;
  IF NOT (public.has_tenant_role(v_tenant,'collector') OR public.has_tenant_role(v_tenant,'manager') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Collector or manager permission required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount = 'NaN'::numeric THEN
    RAISE EXCEPTION 'Payment amount must be greater than zero';
  END IF;
  IF p_method NOT IN ('cash','bank_transfer') THEN
    RAISE EXCEPTION 'Unsupported payment method';
  END IF;
  IF p_client_id IS NOT NULL AND v_client_id IS NULL THEN
    RAISE EXCEPTION 'Client id cannot be empty';
  END IF;

  -- The bill is the serialization point for all payment mutations.
  SELECT wb.total, wb.reading_id
  INTO v_total, v_reading
  FROM public.water_bills wb
  WHERE wb.id = p_bill_id
    AND wb.tenant_id = v_tenant
  FOR UPDATE;

  IF v_total IS NULL THEN
    RAISE EXCEPTION 'Bill not found';
  END IF;

  SELECT wr.verification_status
  INTO v_verification
  FROM public.water_readings wr
  WHERE wr.id = v_reading
    AND wr.tenant_id = v_tenant;

  IF v_reading IS NULL OR v_verification <> 'approved' THEN
    RAISE EXCEPTION 'Bill is not eligible for collection';
  END IF;

  -- Fast path for retries. The unique partial index is the final race guard.
  IF v_client_id IS NOT NULL THEN
    SELECT p.id INTO v_payment
    FROM public.payments p
    WHERE p.tenant_id = v_tenant
      AND p.client_id = v_client_id;

    IF v_payment IS NOT NULL THEN
      SELECT p.id, p.bill_id, p.amount, p.status
      INTO payment_id, bill_id, amount, status
      FROM public.payments p
      WHERE p.id = v_payment;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('approved','pending')),0)
  INTO v_paid
  FROM public.payments p
  WHERE p.bill_id = p_bill_id
    AND p.tenant_id = v_tenant;

  v_outstanding := v_total - v_paid;
  IF v_outstanding <= 0 THEN
    RAISE EXCEPTION 'Bill has no outstanding balance';
  END IF;
  IF p_amount > v_outstanding THEN
    RAISE EXCEPTION 'Payment exceeds the outstanding bill balance';
  END IF;

  BEGIN
    INSERT INTO public.payments(tenant_id,bill_id,amount,method,status,collector_id,client_id)
    VALUES(v_tenant,p_bill_id,p_amount,p_method,'pending',v_uid,v_client_id)
    RETURNING id,bill_id,amount,status INTO payment_id,bill_id,amount,status;
  EXCEPTION WHEN unique_violation THEN
    -- Only recover the tenant/client idempotency race. If another unique
    -- constraint fails, re-raise rather than masking a real data-integrity bug.
    IF v_client_id IS NULL THEN
      RAISE;
    END IF;

    SELECT p.id, p.bill_id, p.amount, p.status
    INTO payment_id, bill_id, amount, status
    FROM public.payments p
    WHERE p.tenant_id = v_tenant
      AND p.client_id = v_client_id;

    IF payment_id IS NULL THEN
      RAISE;
    END IF;
  END;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.record_water_payment(UUID,NUMERIC,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_water_payment(UUID,NUMERIC,TEXT,TEXT) TO authenticated;
