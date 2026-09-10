-- Preserve existing verified reading semantics while hardening new field validation.
UPDATE public.water_readings
SET verification_status = CASE
  WHEN status = 'approved' THEN 'approved'
  WHEN status = 'rejected' THEN 'rejected'
  ELSE 'pending'
END
WHERE verification_status = 'pending';

CREATE OR REPLACE FUNCTION public.record_water_reading(
  p_meter_id UUID,
  p_current NUMERIC,
  p_photo_url TEXT DEFAULT NULL,
  p_capture_source TEXT DEFAULT 'manual',
  p_ocr_serial TEXT DEFAULT NULL,
  p_ocr_confidence NUMERIC DEFAULT NULL,
  p_ocr_raw_text TEXT DEFAULT NULL,
  p_client_id TEXT DEFAULT NULL,
  p_lat NUMERIC DEFAULT NULL,
  p_lng NUMERIC DEFAULT NULL,
  p_accuracy NUMERIC DEFAULT NULL
)
RETURNS TABLE(reading_id UUID, bill_id UUID, previous NUMERIC, current_reading NUMERIC, consumption NUMERIC, bill_total NUMERIC, arrears NUMERIC, project_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_tenant UUID;
  v_customer UUID;
  v_serial TEXT;
  v_prev NUMERIC;
  v_reading UUID;
  v_profile_id UUID;
  v_decimal_digits SMALLINT;
  v_integer_digits SMALLINT;
  v_integer_length INTEGER;
BEGIN
  SELECT p.tenant_id INTO v_tenant FROM public.profiles p WHERE p.id = v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'No tenant is assigned to the authenticated user'; END IF;
  IF NOT (public.has_tenant_role(v_tenant,'reader') OR public.has_tenant_role(v_tenant,'manager')) THEN RAISE EXCEPTION 'Insufficient permission to record readings'; END IF;
  IF p_current IS NULL OR p_current < 0 THEN RAISE EXCEPTION 'Invalid current reading'; END IF;
  IF p_capture_source NOT IN ('camera','phone','manual','offline') THEN RAISE EXCEPTION 'Invalid capture source'; END IF;
  IF p_ocr_confidence IS NOT NULL AND (p_ocr_confidence < 0 OR p_ocr_confidence > 1) THEN RAISE EXCEPTION 'Invalid OCR confidence'; END IF;
  IF p_lat IS NOT NULL AND (p_lat < -90 OR p_lat > 90) THEN RAISE EXCEPTION 'Invalid latitude'; END IF;
  IF p_lng IS NOT NULL AND (p_lng < -180 OR p_lng > 180) THEN RAISE EXCEPTION 'Invalid longitude'; END IF;
  IF p_accuracy IS NOT NULL AND p_accuracy < 0 THEN RAISE EXCEPTION 'Invalid GPS accuracy'; END IF;

  SELECT m.customer_id, m.serial_number, m.profile_id
  INTO v_customer, v_serial, v_profile_id
  FROM public.meters m
  WHERE m.id = p_meter_id AND m.tenant_id = v_tenant AND m.status = 'active';
  IF v_customer IS NULL THEN RAISE EXCEPTION 'Meter is not active or is not assigned to this tenant'; END IF;

  IF v_profile_id IS NOT NULL THEN
    SELECT mp.integer_digits, mp.decimal_digits
    INTO v_integer_digits, v_decimal_digits
    FROM public.meter_profiles mp
    WHERE mp.id = v_profile_id AND mp.tenant_id = v_tenant;
    IF v_decimal_digits IS NOT NULL AND scale(p_current) > v_decimal_digits THEN
      RAISE EXCEPTION 'Reading has more decimal places than the meter profile permits';
    END IF;
    IF v_integer_digits IS NOT NULL AND v_integer_digits > 0 THEN
      v_integer_length := length(abs(trunc(p_current))::bigint::text);
      IF v_integer_length > v_integer_digits THEN
        RAISE EXCEPTION 'Reading exceeds the integer digit capacity of the meter profile';
      END IF;
    END IF;
  END IF;

  IF p_ocr_serial IS NOT NULL AND regexp_replace(upper(p_ocr_serial), '[^A-Z0-9]', '', 'g') <> regexp_replace(upper(v_serial), '[^A-Z0-9]', '', 'g') THEN
    RAISE EXCEPTION 'Meter identity mismatch';
  END IF;

  IF p_client_id IS NOT NULL THEN
    SELECT wr.id INTO v_reading FROM public.water_readings wr WHERE wr.tenant_id = v_tenant AND wr.client_id = p_client_id;
    IF v_reading IS NOT NULL THEN
      SELECT wr.id, NULL::UUID, wr.previous, wr.current_reading, wr.consumption, NULL::NUMERIC, NULL::NUMERIC, COALESCE(t.project_name,t.name)
      INTO reading_id, bill_id, previous, current_reading, consumption, bill_total, arrears, project_name
      FROM public.water_readings wr JOIN public.tenants t ON t.id = wr.tenant_id WHERE wr.id = v_reading;
      RETURN NEXT; RETURN;
    END IF;
  END IF;

  SELECT wr.current_reading INTO v_prev
  FROM public.water_readings wr
  WHERE wr.tenant_id = v_tenant AND wr.meter_id = p_meter_id AND wr.verification_status = 'approved'
  ORDER BY wr.created_at DESC LIMIT 1;
  v_prev := COALESCE(v_prev, 0);
  IF p_current < v_prev THEN RAISE EXCEPTION 'Current reading cannot be lower than previous approved reading'; END IF;

  INSERT INTO public.water_readings(
    tenant_id, customer_id, meter_number, meter_id, previous, current_reading, consumption,
    photo_url, lat, lng, flag, status, reader_id, capture_source, ocr_serial, ocr_confidence,
    ocr_raw_text, identity_verified, reading_verified, client_id, source_device, verification_status
  ) VALUES (
    v_tenant, v_customer, v_serial, p_meter_id, v_prev, p_current, p_current-v_prev,
    p_photo_url, p_lat, p_lng, CASE WHEN p_current=v_prev THEN 'zero' ELSE 'ok' END,
    'pending', v_uid, p_capture_source, p_ocr_serial, p_ocr_confidence, p_ocr_raw_text,
    true, false, p_client_id, NULL, 'pending'
  ) RETURNING id INTO v_reading;

  reading_id := v_reading; bill_id := NULL; previous := v_prev; current_reading := p_current;
  consumption := p_current-v_prev; bill_total := NULL; arrears := NULL;
  SELECT COALESCE(t.project_name,t.name) INTO project_name FROM public.tenants t WHERE t.id=v_tenant;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.record_water_reading(UUID,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,NUMERIC,NUMERIC,NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_water_reading(UUID,NUMERIC,TEXT,TEXT,TEXT,NUMERIC,TEXT,TEXT,NUMERIC,NUMERIC,NUMERIC) TO authenticated;
