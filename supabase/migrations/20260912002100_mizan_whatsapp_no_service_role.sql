-- Keep WhatsApp delivery independent from Supabase service-role/secret-key credentials.
-- The Edge Function authenticates the database webhook with a dedicated shared secret.

CREATE OR REPLACE FUNCTION public.claim_whatsapp_invoice(
  p_outbox_id uuid,
  p_webhook_secret text
)
RETURNS TABLE (
  id uuid,
  bill_id uuid,
  tenant_id uuid,
  customer_name text,
  phone text,
  total numeric,
  arrears numeric,
  issued_at timestamptz,
  status text,
  attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_expected_secret text;
BEGIN
  SELECT decrypted_secret
    INTO v_expected_secret
  FROM vault.decrypted_secrets
  WHERE name = 'mizan_whatsapp_webhook_secret'
  LIMIT 1;

  IF v_expected_secret IS NULL OR p_webhook_secret IS NULL OR v_expected_secret <> p_webhook_secret THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.whatsapp_invoice_outbox AS o
     SET status = 'sending',
         attempts = o.attempts + 1,
         last_attempt_at = now(),
         updated_at = now()
   WHERE o.id = p_outbox_id
     AND o.status IN ('pending', 'failed')
  RETURNING o.id, o.bill_id, o.tenant_id, o.customer_name, o.phone,
            o.total, o.arrears, o.issued_at, o.status, o.attempts;

  IF NOT FOUND THEN
    RETURN QUERY
    SELECT o.id, o.bill_id, o.tenant_id, o.customer_name, o.phone,
           o.total, o.arrears, o.issued_at, o.status, o.attempts
    FROM public.whatsapp_invoice_outbox AS o
    WHERE o.id = p_outbox_id
      AND o.status = 'sent';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_whatsapp_invoice(
  p_outbox_id uuid,
  p_webhook_secret text,
  p_status text,
  p_provider_message_id text,
  p_provider_response jsonb,
  p_last_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_expected_secret text;
BEGIN
  SELECT decrypted_secret
    INTO v_expected_secret
  FROM vault.decrypted_secrets
  WHERE name = 'mizan_whatsapp_webhook_secret'
  LIMIT 1;

  IF v_expected_secret IS NULL OR p_webhook_secret IS NULL OR v_expected_secret <> p_webhook_secret THEN
    RETURN false;
  END IF;

  IF p_status NOT IN ('sent', 'failed') THEN
    RETURN false;
  END IF;

  UPDATE public.whatsapp_invoice_outbox
     SET status = p_status,
         sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE sent_at END,
         provider_message_id = p_provider_message_id,
         provider_response = p_provider_response,
         last_error = p_last_error,
         updated_at = now()
   WHERE id = p_outbox_id
     AND status = 'sending';

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_whatsapp_invoice(uuid,text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_invoice(uuid,text) TO anon;
REVOKE ALL ON FUNCTION public.complete_whatsapp_invoice(uuid,text,text,text,jsonb,text) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_whatsapp_invoice(uuid,text,text,text,jsonb,text) TO anon;

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
  v_webhook_secret text;
  v_outbox_id uuid;
  v_request_id bigint;
BEGIN
  SELECT c.name, c.phone
    INTO v_name, v_phone
  FROM public.customers AS c
  WHERE c.id = NEW.customer_id
    AND c.tenant_id = NEW.tenant_id;

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
    ) ON CONFLICT (bill_id) DO NOTHING;
    RETURN NEW;
  END IF;

  INSERT INTO public.whatsapp_invoice_outbox (
    bill_id, tenant_id, customer_name, phone, total, arrears, issued_at
  ) VALUES (
    NEW.id, NEW.tenant_id, coalesce(v_name, 'عميلنا الكريم'), v_normalized_phone,
    NEW.total, coalesce(NEW.arrears, 0), coalesce(NEW.issued_at, now())
  )
  ON CONFLICT (bill_id) DO NOTHING
  RETURNING id INTO v_outbox_id;

  IF v_outbox_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret
    INTO v_webhook_secret
  FROM vault.decrypted_secrets
  WHERE name = 'mizan_whatsapp_webhook_secret'
  LIMIT 1;

  IF nullif(v_webhook_secret, '') IS NULL THEN
    UPDATE public.whatsapp_invoice_outbox
       SET status = 'failed',
           last_error = 'whatsapp_webhook_secret_not_configured',
           updated_at = now()
     WHERE id = v_outbox_id;
    RETURN NEW;
  END IF;

  SELECT net.http_post(
    url := 'https://fpwmaxrawtskwcauvahu.supabase.co/functions/v1/whatsapp-invoice',
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'whatsapp_invoice_outbox',
      'schema', 'public',
      'record', jsonb_build_object('id', v_outbox_id)
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-mizan-webhook-secret', v_webhook_secret
    ),
    timeout_milliseconds := 5000
  ) INTO v_request_id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_whatsapp_invoice_after_bill() FROM PUBLIC, anon, authenticated;
