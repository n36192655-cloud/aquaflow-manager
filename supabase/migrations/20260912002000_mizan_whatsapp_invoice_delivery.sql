-- MIZAN WhatsApp invoice delivery
-- Production path: approved bill INSERT -> durable outbox -> pg_net webhook -> Edge Function -> Meta WhatsApp Cloud API.
-- No browser secret and no legacy service-role key is used by the application.

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

CREATE TABLE IF NOT EXISTS public.whatsapp_invoice_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL UNIQUE REFERENCES public.water_bills(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  customer_name text NOT NULL,
  phone text NOT NULL,
  total numeric NOT NULL CHECK (total >= 0),
  arrears numeric NOT NULL DEFAULT 0 CHECK (arrears >= 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  provider_response jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_invoice_outbox_status_idx
  ON public.whatsapp_invoice_outbox(status, created_at);

ALTER TABLE public.whatsapp_invoice_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_invoice_outbox FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.normalize_whatsapp_phone(_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT regexp_replace(
    CASE
      WHEN trim(_phone) LIKE '+%' THEN substring(trim(_phone) from 2)
      WHEN trim(_phone) LIKE '00%' THEN substring(trim(_phone) from 3)
      WHEN trim(_phone) LIKE '0%' THEN '967' || substring(trim(_phone) from 2)
      ELSE trim(_phone)
    END,
    '[^0-9]', '', 'g'
  );
$$;

REVOKE ALL ON FUNCTION public.normalize_whatsapp_phone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_whatsapp_phone(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.queue_whatsapp_invoice_after_bill()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text;
  v_phone text;
  v_normalized_phone text;
  v_webhook_key text;
  v_request_id bigint;
BEGIN
  SELECT c.name, c.phone
    INTO v_name, v_phone
  FROM public.customers AS c
  WHERE c.id = NEW.customer_id
    AND c.tenant_id = NEW.tenant_id;

  -- A bill must remain successfully issued even if the customer has no WhatsApp number.
  -- The outbox records only deliverable numbers, so missing phone data is explicit rather than guessed.
  IF nullif(trim(coalesce(v_phone, '')), '') IS NULL THEN
    RETURN NEW;
  END IF;

  v_normalized_phone := public.normalize_whatsapp_phone(v_phone);
  IF v_normalized_phone !~ '^9677[0-9]{8}$' THEN
    INSERT INTO public.whatsapp_invoice_outbox (
      bill_id, tenant_id, customer_name, phone, total, arrears, issued_at, status, last_error
    ) VALUES (
      NEW.id, NEW.tenant_id, coalesce(v_name, 'عميلنا الكريم'), v_normalized_phone,
      NEW.total, coalesce(NEW.arrears, 0), coalesce(NEW.issued_at, now()), 'failed',
      'invalid_yemeni_whatsapp_number'
    )
    ON CONFLICT (bill_id) DO NOTHING;
    RETURN NEW;
  END IF;

  INSERT INTO public.whatsapp_invoice_outbox (
    bill_id, tenant_id, customer_name, phone, total, arrears, issued_at
  ) VALUES (
    NEW.id, NEW.tenant_id, coalesce(v_name, 'عميلنا الكريم'), v_normalized_phone,
    NEW.total, coalesce(NEW.arrears, 0), coalesce(NEW.issued_at, now())
  )
  ON CONFLICT (bill_id) DO NOTHING;

  -- The key is stored encrypted in Supabase Vault. It is never committed to Git or exposed to the browser.
  SELECT decrypted_secret
    INTO v_webhook_key
  FROM vault.decrypted_secrets
  WHERE name = 'mizan_whatsapp_webhook_secret_key'
  LIMIT 1;

  IF nullif(v_webhook_key, '') IS NULL THEN
    UPDATE public.whatsapp_invoice_outbox
       SET status = 'failed',
           last_error = 'whatsapp_webhook_secret_not_configured',
           updated_at = now()
     WHERE bill_id = NEW.id AND status = 'pending';
    RETURN NEW;
  END IF;

  SELECT net.http_post(
    url := 'https://fpwmaxrawtskwcauvahu.supabase.co/functions/v1/whatsapp-invoice',
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'whatsapp_invoice_outbox',
      'schema', 'public',
      'record', jsonb_build_object('id', (SELECT id FROM public.whatsapp_invoice_outbox WHERE bill_id = NEW.id))
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_webhook_key
    ),
    timeout_milliseconds := 5000
  ) INTO v_request_id;

  UPDATE public.whatsapp_invoice_outbox
     SET last_attempt_at = now(),
         updated_at = now()
   WHERE bill_id = NEW.id AND status = 'pending';

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_whatsapp_invoice_after_bill() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_queue_whatsapp_invoice_after_bill ON public.water_bills;
CREATE TRIGGER trg_queue_whatsapp_invoice_after_bill
AFTER INSERT ON public.water_bills
FOR EACH ROW
EXECUTE FUNCTION public.queue_whatsapp_invoice_after_bill();

CREATE OR REPLACE FUNCTION public.whatsapp_invoice_outbox_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.whatsapp_invoice_outbox_touch_updated_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_whatsapp_invoice_outbox_updated_at ON public.whatsapp_invoice_outbox;
CREATE TRIGGER trg_whatsapp_invoice_outbox_updated_at
BEFORE UPDATE ON public.whatsapp_invoice_outbox
FOR EACH ROW
EXECUTE FUNCTION public.whatsapp_invoice_outbox_touch_updated_at();
