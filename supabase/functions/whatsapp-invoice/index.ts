import { withSupabase } from "npm:@supabase/server@^1";

const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_API_VERSION") ?? "v23.0";
const PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
const ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
const TEMPLATE_NAME = Deno.env.get("WHATSAPP_INVOICE_TEMPLATE") ?? "mizan_invoice_issued";
const TEMPLATE_LANGUAGE = Deno.env.get("WHATSAPP_INVOICE_TEMPLATE_LANGUAGE") ?? "ar";

interface WebhookPayload {
  type?: string;
  table?: string;
  schema?: string;
  record?: { id?: string };
  old_record?: unknown;
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  fetch: withSupabase({ auth: "secret:whatsapp_webhook" }, async (req, ctx) => {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) return json(503, { error: "whatsapp_not_configured" });

    let payload: WebhookPayload;
    try {
      payload = await req.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }

    if (payload.schema !== "public" || payload.table !== "whatsapp_invoice_outbox" || payload.type !== "INSERT") {
      return json(400, { error: "invalid_webhook_event" });
    }

    const outboxId = payload.record?.id;
    if (!outboxId) return json(400, { error: "missing_outbox_id" });

    const { data: job, error: readError } = await ctx.supabaseAdmin
      .from("whatsapp_invoice_outbox")
      .select("id,bill_id,tenant_id,customer_name,phone,total,arrears,issued_at,status,attempts")
      .eq("id", outboxId)
      .maybeSingle();

    if (readError) return json(500, { error: "outbox_read_failed" });
    if (!job) return json(404, { error: "outbox_not_found" });
    if (job.status === "sent") return json(200, { ok: true, status: "already_sent" });

    await ctx.supabaseAdmin
      .from("whatsapp_invoice_outbox")
      .update({ status: "sending", attempts: Number(job.attempts ?? 0) + 1, last_attempt_at: new Date().toISOString() })
      .eq("id", job.id);

    const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: job.phone,
        type: "template",
        template: {
          name: TEMPLATE_NAME,
          language: { code: TEMPLATE_LANGUAGE },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: job.customer_name || "عميلنا الكريم" },
                { type: "text", text: job.bill_id },
                { type: "text", text: Number(job.total).toFixed(2) },
                { type: "text", text: new Date(job.issued_at).toLocaleDateString("ar-YE") },
              ],
            },
          ],
        },
      }),
    });

    const responseText = await response.text();
    let responseJson: Record<string, unknown> = {};
    try { responseJson = JSON.parse(responseText); } catch { /* keep raw response below */ }

    if (!response.ok) {
      const errorMessage = typeof responseJson.error === "object" && responseJson.error !== null
        ? String((responseJson.error as { message?: unknown }).message ?? responseText).slice(0, 1000)
        : responseText.slice(0, 1000);
      await ctx.supabaseAdmin
        .from("whatsapp_invoice_outbox")
        .update({ status: "failed", last_error: errorMessage, provider_response: responseJson })
        .eq("id", job.id);
      return json(502, { error: "whatsapp_send_failed" });
    }

    const messageId = Array.isArray(responseJson.messages)
      ? String((responseJson.messages[0] as { id?: unknown })?.id ?? "")
      : "";

    await ctx.supabaseAdmin
      .from("whatsapp_invoice_outbox")
      .update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: messageId || null, provider_response: responseJson, last_error: null })
      .eq("id", job.id);

    return json(200, { ok: true, status: "sent", message_id: messageId || null });
  }),
};
