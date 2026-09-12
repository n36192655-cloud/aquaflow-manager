import { withSupabase } from "npm:@supabase/server@^1";

const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_API_VERSION") ?? "v23.0";
const PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
const ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
const TEMPLATE_NAME = Deno.env.get("WHATSAPP_INVOICE_TEMPLATE") ?? "mizan_invoice_issued";
const TEMPLATE_LANGUAGE = Deno.env.get("WHATSAPP_INVOICE_TEMPLATE_LANGUAGE") ?? "ar";
const WEBHOOK_SECRET = Deno.env.get("WHATSAPP_WEBHOOK_SECRET");

interface WebhookPayload {
  type?: string;
  table?: string;
  schema?: string;
  record?: { id?: string };
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (!WEBHOOK_SECRET) return json(503, { error: "webhook_not_configured" });
    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) return json(503, { error: "whatsapp_not_configured" });

    const suppliedSecret = req.headers.get("x-mizan-webhook-secret") ?? "";
    if (!safeEqual(suppliedSecret, WEBHOOK_SECRET)) return json(401, { error: "unauthorized" });

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

    const { data: jobs, error: claimError } = await ctx.supabase.rpc("claim_whatsapp_invoice", {
      p_outbox_id: outboxId,
      p_webhook_secret: WEBHOOK_SECRET,
    });

    if (claimError) return json(500, { error: "outbox_claim_failed" });
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    if (!job) return json(404, { error: "outbox_not_found_or_not_claimable" });
    if (job.status === "sent") return json(200, { ok: true, status: "already_sent" });

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
    try { responseJson = JSON.parse(responseText); } catch { /* raw response is stored as an error message */ }

    if (!response.ok) {
      const errorMessage = typeof responseJson.error === "object" && responseJson.error !== null
        ? String((responseJson.error as { message?: unknown }).message ?? responseText).slice(0, 1000)
        : responseText.slice(0, 1000);
      await ctx.supabase.rpc("complete_whatsapp_invoice", {
        p_outbox_id: outboxId,
        p_webhook_secret: WEBHOOK_SECRET,
        p_status: "failed",
        p_provider_message_id: null,
        p_provider_response: responseJson,
        p_last_error: errorMessage,
      });
      return json(502, { error: "whatsapp_send_failed" });
    }

    const messageId = Array.isArray(responseJson.messages)
      ? String((responseJson.messages[0] as { id?: unknown })?.id ?? "")
      : "";

    const { error: completeError } = await ctx.supabase.rpc("complete_whatsapp_invoice", {
      p_outbox_id: outboxId,
      p_webhook_secret: WEBHOOK_SECRET,
      p_status: "sent",
      p_provider_message_id: messageId || null,
      p_provider_response: responseJson,
      p_last_error: null,
    });

    if (completeError) return json(500, { error: "outbox_complete_failed" });
    return json(200, { ok: true, status: "sent", message_id: messageId || null });
  }),
};
