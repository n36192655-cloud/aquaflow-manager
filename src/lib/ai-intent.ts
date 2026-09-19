import { supabase } from "./supabase";

export type AiResponse =
  | { kind: "text"; text: string; suggestions?: string[] }
  | { kind: "suggestions"; text: string; suggestions: string[] }
  | {
      kind: "subscriber_ledger";
      customer: { id: string; name: string; phone: string | null; pay_account: string | null; address?: string | null };
      totals: { paid: number; arrears: number; billed: number };
      series: Array<{ label: string; consumption: number; amount: number }>;
    }
  | {
      kind: "loss_analysis";
      range: { from: string; to: string };
      water: { produced: number; consumed: number; loss: number; pct: number | null };
      alerts: string[];
    }
  | {
      kind: "payment_status";
      paid: Array<{ id: string; name: string; serial: string; total: number }>;
      unpaid: Array<{ id: string; name: string; serial: string; total: number; balance: number }>;
    }
  | {
      kind: "revenue_report";
      range: { from: string; to: string; label: string };
      totals: { cash: number; bank: number; total: number; count: number; avg: number };
      series: Array<{ day: string; cash: number; bank: number; total: number }>;
    };

const SUGGESTIONS = [
  "استعلام عن مشترك",
  "تحليل الفاقد لهذا الشهر",
  "من دفع ومن لم يدفع؟",
  "استعلام عن التحصيل اليوم",
];

function rangeFor(text: string) {
  const now = new Date();
  if (text.includes("اليوم")) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { start, end: new Date(start.getTime() + 86400000), label: "اليوم" };
  }
  if (text.includes("أسبوع") || text.includes("اسبوع")) {
    return { start: new Date(now.getTime() - 7 * 86400000), end: now, label: "آخر 7 أيام" };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { start, end: new Date(now.getFullYear(), now.getMonth() + 1, 1), label: "هذا الشهر" };
}

function day(t: string) {
  return new Date(t).toISOString().slice(0, 10);
}

function genericDataError(): AiResponse {
  return {
    kind: "text",
    text: "تعذر قراءة البيانات الحقيقية من قاعدة البيانات حالياً. لم يتم إنشاء أو تقدير أي نتيجة.",
    suggestions: SUGGESTIONS,
  };
}

async function currentTenantId(): Promise<string | null> {
  const { data, error } = await supabase.rpc("current_tenant_id");
  if (error || typeof data !== "string" || !data) return null;
  return data;
}

async function subscriberLedger(tenantId: string, text: string): Promise<AiResponse> {
  const match = text.match(/(?:عن\s+مشترك|مشترك|حساب|كشف\s+حساب)\s+(.+?)(?:$|[?؟])/);
  const query = (match?.[1] ?? "").trim();

  if (!query) {
    return { kind: "suggestions", text: "حدد المشترك بالاسم أو رقم الهاتف أو رقم حساب السداد.", suggestions: SUGGESTIONS };
  }

  const [byName, byPhone, byAccount] = await Promise.all([
    supabase.from("customers").select("id,name,phone,address,pay_account").eq("tenant_id", tenantId).ilike("name", `%${query}%`).limit(5),
    supabase.from("customers").select("id,name,phone,address,pay_account").eq("tenant_id", tenantId).ilike("phone", `%${query}%`).limit(5),
    supabase.from("customers").select("id,name,phone,address,pay_account").eq("tenant_id", tenantId).ilike("pay_account", `%${query}%`).limit(5),
  ]);
  const error = byName.error ?? byPhone.error ?? byAccount.error;
  if (error) return genericDataError();

  const customers = [...(byName.data ?? []), ...(byPhone.data ?? []), ...(byAccount.data ?? [])];
  const uniqueCustomers = customers.filter((item, index, all) => all.findIndex((x) => x.id === item.id) === index);
  if (uniqueCustomers.length === 0) {
    return { kind: "suggestions", text: "لم أجد مشتركاً مطابقاً في قاعدة البيانات الحالية. لم يتم اختراع نتيجة.", suggestions: SUGGESTIONS };
  }
  if (uniqueCustomers.length > 1) {
    return {
      kind: "suggestions",
      text: "وجدت أكثر من مشترك مطابق. استخدم الاسم الكامل أو رقم الهاتف/حساب السداد لتحديد السجل بدقة.",
      suggestions: uniqueCustomers.slice(0, 6).map((item) => `استعلام عن مشترك ${item.name}`),
    };
  }
  const customer = uniqueCustomers[0];

  const billsResult = await supabase
    .from("water_bills")
    .select("id,reading_id,total,status,issued_at")
    .eq("tenant_id", tenantId)
    .eq("customer_id", customer.id)
    .order("issued_at", { ascending: true });
  if (billsResult.error) return genericDataError();

  const bills = billsResult.data ?? [];
  const billIds = bills.map((b) => b.id);
  const paymentsResult = billIds.length
    ? await supabase.from("payments").select("id,bill_id,amount,status,created_at").eq("tenant_id", tenantId).in("bill_id", billIds).order("created_at", { ascending: true })
    : { data: [], error: null };
  if (paymentsResult.error) return genericDataError();

  const payments = paymentsResult.data ?? [];
  const paidByBill = new Map<string, number>();
  for (const payment of payments) {
    if (payment.status === "approved") paidByBill.set(payment.bill_id, (paidByBill.get(payment.bill_id) ?? 0) + Number(payment.amount));
  }

  const billed = bills.reduce((sum, bill) => sum + Number(bill.total), 0);
  const paid = payments.filter((p) => p.status === "approved").reduce((sum, p) => sum + Number(p.amount), 0);
  const arrears = bills.reduce((sum, bill) => sum + Math.max(0, Number(bill.total) - (paidByBill.get(bill.id) ?? 0)), 0);

  const readingIds = bills.map((b) => b.reading_id).filter((id): id is string => Boolean(id));
  const readingsResult = readingIds.length
    ? await supabase.from("water_readings").select("id,consumption,created_at").eq("tenant_id", tenantId).in("id", readingIds)
    : { data: [], error: null };
  if (readingsResult.error) return genericDataError();
  const readings = new Map((readingsResult.data ?? []).map((reading) => [reading.id, reading]));

  const series = bills.slice(-12).map((bill) => ({
    label: new Intl.DateTimeFormat("ar-YE", { month: "short", day: "numeric" }).format(new Date(bill.issued_at)),
    consumption: Number(readings.get(bill.reading_id ?? "")?.consumption ?? 0),
    amount: Number(bill.total),
  }));

  return {
    kind: "subscriber_ledger",
    customer: { id: customer.id, name: customer.name, phone: customer.phone, pay_account: customer.pay_account, address: customer.address },
    totals: { paid, arrears, billed },
    series,
  };
}

async function lossAnalysis(tenantId: string, text: string): Promise<AiResponse> {
  const range = rangeFor(text);
  const start = range.start.toISOString();
  const end = range.end.toISOString();

  const [productionResult, readingsResult] = await Promise.all([
    supabase.from("water_production_logs").select("production_m3,recorded_at,verification_status").eq("tenant_id", tenantId).gte("recorded_at", start).lt("recorded_at", end),
    supabase.from("water_readings").select("consumption,created_at,status,verification_status").eq("tenant_id", tenantId).gte("created_at", start).lt("created_at", end),
  ]);
  if (productionResult.error || readingsResult.error) return genericDataError();

  const production = (productionResult.data ?? [])
    .filter((row) => row.verification_status === "approved" && Number.isFinite(Number(row.production_m3)) && Number(row.production_m3) > 0)
    .reduce((sum, row) => sum + Number(row.production_m3), 0);
  const consumed = (readingsResult.data ?? [])
    .filter((row) => row.verification_status === "approved" && row.status === "approved" && Number.isFinite(Number(row.consumption)) && Number(row.consumption) >= 0)
    .reduce((sum, row) => sum + Number(row.consumption), 0);

  const loss = production - consumed;
  const pct = production > 0 ? (loss / production) * 100 : null;
  const alerts: string[] = [];
  if (production === 0) alerts.push("غير متاح: لا توجد بيانات إنتاج/ضخ معتمدة في الفترة.");
  if (loss < 0) alerts.push("تحذير جودة بيانات: الاستهلاك المعتمد يتجاوز مدخل المياه المعتمد؛ لم يتم إخفاء التناقض أو تحويله إلى صفر.");
  if (pct != null && pct > 15) alerts.push(`الفاقد الحسابي ${pct.toFixed(1)}% ويتطلب تفسيراً ميدانياً قبل وصفه كتسرب أو فاقد فني.`);

  return {
    kind: "loss_analysis",
    range: { from: day(start), to: day(new Date(range.end.getTime() - 1).toISOString()) },
    water: { produced: production, consumed, loss, pct },
    alerts,
  };
}

async function paymentStatus(tenantId: string): Promise<AiResponse> {
  const [billsResult, customersResult, paymentsResult] = await Promise.all([
    supabase.from("water_bills").select("id,reading_id,total,status,customer_id").eq("tenant_id", tenantId).order("issued_at", { ascending: false }).limit(200),
    supabase.from("customers").select("id,name").eq("tenant_id", tenantId),
    supabase.from("payments").select("bill_id,amount,status").eq("tenant_id", tenantId),
  ]);
  if (billsResult.error || customersResult.error || paymentsResult.error) return genericDataError();

  const customers = new Map((customersResult.data ?? []).map((c) => [c.id, c.name]));
  const approvedByBill = new Map<string, number>();
  for (const p of paymentsResult.data ?? []) {
    if (p.status === "approved") approvedByBill.set(p.bill_id, (approvedByBill.get(p.bill_id) ?? 0) + Number(p.amount));
  }

  const paid: Array<{ id: string; name: string; serial: string; total: number }> = [];
  const unpaid: Array<{ id: string; name: string; serial: string; total: number; balance: number }> = [];
  const readingIds = (billsResult.data ?? []).map((b) => b.reading_id).filter((id): id is string => Boolean(id));
  const readingsResult = readingIds.length ? await supabase.from("water_readings").select("id,meter_number").in("id", readingIds) : { data: [], error: null };
  if (readingsResult.error) return genericDataError();
  const meterNumbers = new Map((readingsResult.data ?? []).map((r) => [r.id, r.meter_number]));
  for (const bill of billsResult.data ?? []) {
    const total = Number(bill.total);
    const paidAmount = approvedByBill.get(bill.id) ?? 0;
    const balance = Math.max(0, total - paidAmount);
    const name = customers.get(bill.customer_id) ?? "—";
    if (balance <= 0 && paidAmount > 0) paid.push({ id: bill.id, name, serial: meterNumbers.get(bill.reading_id ?? "") ?? "—", total });
    else unpaid.push({ id: bill.id, name, serial: bill.serial, total, balance });
  }
  return { kind: "payment_status", paid, unpaid };
}

async function revenueReport(tenantId: string, text: string): Promise<AiResponse> {
  const range = rangeFor(text);
  const [paymentsResult] = await Promise.all([
    supabase.from("payments").select("amount,status,method,created_at").eq("tenant_id", tenantId).eq("status", "approved").gte("created_at", range.start.toISOString()).lt("created_at", range.end.toISOString()),
  ]);
  if (paymentsResult.error) return genericDataError();

  const cash = (paymentsResult.data ?? []).filter((p) => p.method === "cash").reduce((sum, p) => sum + Number(p.amount), 0);
  const bank = (paymentsResult.data ?? []).filter((p) => p.method !== "cash").reduce((sum, p) => sum + Number(p.amount), 0);
  const total = cash + bank;
  const days = new Map<string, { cash: number; bank: number; total: number }>();
  for (const p of paymentsResult.data ?? []) {
    const key = day(p.created_at);
    const row = days.get(key) ?? { cash: 0, bank: 0, total: 0 };
    if (p.method === "cash") row.cash += Number(p.amount); else row.bank += Number(p.amount);
    row.total += Number(p.amount);
    days.set(key, row);
  }

  return {
    kind: "revenue_report",
    range: { from: day(range.start.toISOString()), to: day(new Date(range.end.getTime() - 1).toISOString()), label: range.label },
    totals: { cash, bank, total, count: paymentsResult.data?.length ?? 0, avg: paymentsResult.data?.length ? total / paymentsResult.data.length : 0 },
    series: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dayKey, value]) => ({ day: dayKey.slice(5), ...value })),
  };
}

export async function answerQuestion(q: string): Promise<AiResponse> {
  const text = q.trim();
  if (!text) return { kind: "suggestions", text: "اكتب سؤالك وسأبحث في بيانات المشروع الحالية فقط.", suggestions: SUGGESTIONS };

  const tenantId = await currentTenantId();
  if (!tenantId) {
    return { kind: "text", text: "لا يوجد مشروع تشغيلي مرتبط بالحساب الحالي. لا توجد بيانات يمكن عرضها.", suggestions: SUGGESTIONS };
  }

  try {
    if (text.includes("مشترك") || text.includes("كشف حساب") || text.includes("رصيد") || text.includes("ذمة")) {
      return await subscriberLedger(tenantId, text);
    }
    if (text.includes("فاقد") || text.includes("تسرب") || text.includes("خسائر") || text.includes("تحليل الفاقد")) {
      return await lossAnalysis(tenantId, text);
    }
    if (text.includes("من دفع") || text.includes("من لم يدفع") || text.includes("المدفوع") || text.includes("غير المدفوع") || text.includes("حالة الدفع")) {
      return await paymentStatus(tenantId);
    }
    if (text.includes("تحصيل") || text.includes("محصل") || text.includes("ايراد") || text.includes("إيراد") || text.includes("دخل")) {
      return await revenueReport(tenantId, text);
    }
    return { kind: "suggestions", text: "أستطيع الإجابة من بيانات قاعدة البيانات الحالية فقط. اختر نوع الاستعلام:", suggestions: SUGGESTIONS };
  } catch {
    return genericDataError();
  }
}
