-- Atomic authoritative reading submission. The client only supplies a candidate reading;
-- tenant, customer/meter assignment and previous reading are checked on the server.
CREATE OR REPLACE FUNCTION public.calculate_water_charge(_units NUMERIC)
RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE total NUMERIC := 0;
BEGIN
  IF _units <= 0 THEN RETURN 0; END IF;
  total := total + LEAST(_units, 10) * 100;
  IF _units > 10 THEN total := total + LEAST(_units - 10, 20) * 200; END IF;
  IF _units > 30 THEN total := total + LEAST(_units - 30, 70) * 350; END IF;
  IF _units > 100 THEN total := total + (_units - 100) * 350; END IF;
  RETURN total;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_water_bill_reading ON public.water_bills(reading_id) WHERE reading_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.submit_water_reading(
  _client_id TEXT,
  _meter_id UUID,
  _customer_id UUID,
  _current NUMERIC,
  _photo_url TEXT DEFAULT NULL,
  _lat NUMERIC DEFAULT NULL,
  _lng NUMERIC DEFAULT NULL,
  _source TEXT DEFAULT 'manual',
  _identity_status TEXT DEFAULT 'unverified',
  _identity_confidence NUMERIC DEFAULT NULL,
  _reading_confidence NUMERIC DEFAULT NULL,
  _decimal_places SMALLINT DEFAULT 0,
  _cycle_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := public.current_tenant_id();
  v_meter RECORD;
  v_previous NUMERIC := 0;
  v_consumption NUMERIC;
  v_reading UUID;
  v_bill UUID;
  v_subtotal NUMERIC;
  v_arrears NUMERIC;
  v_total NUMERIC;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF _current IS NULL OR _current < 0 THEN RAISE EXCEPTION 'invalid_reading'; END IF;
  IF _decimal_places < 0 OR _decimal_places > 6 THEN RAISE EXCEPTION 'invalid_precision'; END IF;

  SELECT m.id, m.meter_number, m.customer_id, m.profile_id INTO v_meter
  FROM public.water_meters m
  WHERE m.id = _meter_id AND m.customer_id = _customer_id AND m.tenant_id = v_tenant AND m.status = 'active'
  FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'meter_customer_mismatch'; END IF;

  IF _client_id IS NOT NULL THEN
    SELECT id INTO v_reading FROM public.water_readings WHERE tenant_id = v_tenant AND client_id = _client_id;
    IF FOUND THEN
      SELECT id INTO v_bill FROM public.water_bills WHERE tenant_id = v_tenant AND reading_id = v_reading;
      RETURN jsonb_build_object('reading_id', v_reading, 'bill_id', v_bill, 'idempotent', true);
    END IF;
  END IF;

  SELECT wr.current_reading INTO v_previous
  FROM public.water_readings wr
  WHERE wr.tenant_id = v_tenant AND wr.meter_id = _meter_id AND wr.status <> 'rejected'
  ORDER BY wr.created_at DESC LIMIT 1;
  v_previous := COALESCE(v_previous, 0);
  IF _current < v_previous THEN RAISE EXCEPTION 'reading_below_previous'; END IF;
  v_consumption := round(_current - v_previous, _decimal_places);
  v_subtotal := public.calculate_water_charge(v_consumption);

  SELECT COALESCE(sum(GREATEST(0, b.total - COALESCE((SELECT sum(p.amount) FROM public.payments p WHERE p.bill_id=b.id AND p.status='approved'),0))),0)
    INTO v_arrears
  FROM public.water_bills b
  WHERE b.tenant_id = v_tenant AND b.customer_id = _customer_id AND b.status <> 'paid';
  v_total := v_subtotal + v_arrears;

  INSERT INTO public.water_readings (tenant_id, customer_id, meter_number, meter_id, client_id, previous, current_reading, consumption, photo_url, lat, lng, flag, status, reader_id, source, identity_status, identity_confidence, reading_confidence, decimal_places, captured_at, sync_status)
  VALUES (v_tenant, _customer_id, v_meter.meter_number, _meter_id, _client_id, v_previous, _current, v_consumption, _photo_url, _lat, _lng, 'ok', 'pending', auth.uid(), _source, _identity_status, _identity_confidence, _reading_confidence, _decimal_places, now(), 'synced')
  RETURNING id INTO v_reading;

  INSERT INTO public.water_bills (tenant_id, customer_id, meter_id, reading_id, cycle_id, subtotal, arrears, total, status, invoice_number)
  VALUES (v_tenant, _customer_id, _meter_id, v_reading, _cycle_id, v_subtotal, v_arrears, v_total, 'unpaid', 'INV-' || to_char(now(),'YYYYMMDD') || '-' || substr(replace(v_reading::text,'-',''),1,10))
  RETURNING id INTO v_bill;

  INSERT INTO public.audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
  VALUES (v_tenant, auth.uid(), 'submit_water_reading', 'water_readings', v_reading::text, jsonb_build_object('meter_id', _meter_id, 'customer_id', _customer_id, 'source', _source));

  RETURN jsonb_build_object('reading_id', v_reading, 'bill_id', v_bill, 'previous', v_previous, 'consumption', v_consumption, 'arrears', v_arrears, 'total', v_total, 'idempotent', false);
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_water_charge(NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.calculate_water_charge(NUMERIC) TO authenticated;
REVOKE ALL ON FUNCTION public.submit_water_reading(TEXT, UUID, UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC, SMALLINT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_water_reading(TEXT, UUID, UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, NUMERIC, SMALLINT, UUID) TO authenticated;
