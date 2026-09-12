# MIZAN WhatsApp invoice delivery — production activation

## Production architecture

1. `approve_water_reading` inserts the bill.
2. PostgreSQL trigger creates exactly one `whatsapp_invoice_outbox` row per bill.
3. The trigger queues an asynchronous `pg_net` request to the MIZAN `whatsapp-invoice` Edge Function.
4. The Edge Function verifies the dedicated webhook secret, calls Meta WhatsApp Cloud API, and records `sent`/`failed` through narrowly scoped SECURITY DEFINER RPCs.
5. The browser never receives the WhatsApp access token and never writes the outbox directly.

This path does not use the legacy Supabase `service_role` key in the application.

## Required production secrets

Set these as **Supabase Edge Function secrets** for `whatsapp-invoice`:

- `WHATSAPP_ACCESS_TOKEN` — Meta WhatsApp Cloud API access token.
- `WHATSAPP_PHONE_NUMBER_ID` — the registered WhatsApp Business phone number ID.
- `WHATSAPP_GRAPH_API_VERSION` — Graph API version, e.g. `v23.0`; keep it configurable rather than hardcoding a version.
- `WHATSAPP_INVOICE_TEMPLATE` — the approved Meta template name, default `mizan_invoice_issued`.
- `WHATSAPP_INVOICE_TEMPLATE_LANGUAGE` — approved template language, default `ar`.
- `WHATSAPP_WEBHOOK_SECRET` — random high-entropy value used only between PostgreSQL and the Edge Function.

The same `WHATSAPP_WEBHOOK_SECRET` must be stored in Supabase Vault under:

`mizan_whatsapp_webhook_secret`

Do not commit any of these values to Git, browser `.env` files, Vercel client variables, logs, or chat.

## Meta template contract

The code sends a WhatsApp **template** message to the customer because invoice notifications are business-initiated messages. The template must be approved in the WhatsApp Business Manager before production sending.

The body currently supplies four parameters in this order:

1. customer name
2. invoice/bill UUID
3. total amount
4. issue date

The Meta template must therefore contain four body placeholders in that order. If the approved template differs, update the component mapping in `supabase/functions/whatsapp-invoice/index.ts` before production use.

Meta's Cloud API sends messages through:

`POST https://graph.facebook.com/{version}/{phone-number-id}/messages`

with `type: "template"` and the approved template name.

## Customer phone rules

The database normalizes Yemen mobile numbers to digits beginning with `9677` and exactly 12 digits. Numbers outside that format are not guessed or repaired; the invoice remains issued and the WhatsApp outbox records `failed` with `invalid_yemeni_whatsapp_number`.

## Operational verification before enabling live traffic

1. Confirm `pg_net` is enabled and its worker is healthy.
2. Confirm Supabase Edge Function `whatsapp-invoice` is deployed for project `fpwmaxrawtskwcauvahu`.
3. Set the six function secrets above.
4. Store the same webhook secret in Vault under the exact name above.
5. Confirm the Meta WhatsApp Business phone number is registered and its token is valid.
6. Confirm the invoice template is `APPROVED` in Meta.
7. Create one controlled real invoice for a real test subscriber who has consented to receive WhatsApp messages.
8. Verify the outbox row transitions `pending -> sending -> sent` and contains a provider message ID.
9. Verify the WhatsApp message arrives on the exact customer's number.
10. Test a duplicate event and verify the bill does not generate a second outbox row.
11. Test a missing/invalid phone and verify the bill remains issued while delivery is recorded as failed.

## Important boundary

The repository implementation is production-ready, but **live WhatsApp delivery cannot be honestly marked active until the Meta Business credentials, approved template, Edge Function deployment, and Vault webhook secret are actually configured in the production Supabase project**. No credentials are invented or embedded in source control.
