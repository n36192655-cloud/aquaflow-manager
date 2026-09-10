-- Legacy records already contain tenant, customer and meter_number but may predate meters.meter_id.
-- Backfill only missing meter rows; never overwrite existing meter records.
INSERT INTO public.meters (tenant_id, customer_id, serial_number, status)
SELECT DISTINCT wr.tenant_id, wr.customer_id, wr.meter_number, 'active'
FROM public.water_readings wr
WHERE wr.customer_id IS NOT NULL
  AND NULLIF(trim(wr.meter_number), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.meters m
    WHERE m.tenant_id = wr.tenant_id
      AND m.serial_number = wr.meter_number
  );

UPDATE public.water_readings wr
SET meter_id = m.id
FROM public.meters m
WHERE wr.meter_id IS NULL
  AND wr.customer_id = m.customer_id
  AND wr.tenant_id = m.tenant_id
  AND wr.meter_number = m.serial_number;
