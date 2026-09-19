import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDollarSign, Droplets, RefreshCw, ShieldAlert, TrendingDown, TrendingUp, Wallet, Waves } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { fmtYER } from "@/lib/pricing";

export const Route = createFileRoute("/")({ head: () => ({ meta: [{ title: "لوحة الاستدامة — ميزان" }] }), component: Dashboard });

type Reading = { id: string; customer_id: string | null; consumption: number; current_reading: number; previous: number; status: string; verification_status: string; created_at: string };
type Bill = { id: string; reading_id: string | null; total: number; status: string; issued_at: string };
type Payment = { id: string; bill_id: string; amount: number; status: string; created_at: string };
type Production = { id: string; production_m3: number; recorded_at: string; capture_source: string; verification_status: string };
type Metrics = { tenantName: string; windowStart: string; windowEnd: string; approvedConsumption: number; productionInput: number | null; waterEfficiency: number | null; meteredBalanceGap: number | null; approvedPayments: number; eligibleBilled: number; collectionRate: number | null; approvedReadings: number; totalReadings: number; operationalEfficiency: number | null; productionAvailable: boolean; activeCustomers: number; representedPeople: number; avgPerCapitaLpd: number | null; monthlyTrend: { month: string; consumption: number; production: number; nrw: number | null; billed: number; collected: number }[]; consumptionTrend: { date: string; value: number }[]; productionTrend: { date: string; production: number; consumption: number }[]; nrwTrend: { date: string; value: number | null }[]; financialTrend: { date: string; billed: number; collected: number }[]; workflow: { pending: number; approved: number; rejected: number }; alerts: string[] };
const empty: Metrics = { tenantName: "", windowStart: "", windowEnd: "", approvedConsumption: 0, productionInput: null, waterEfficiency: null, meteredBalanceGap: null, approvedPayments: 0, eligibleBilled: 0, collectionRate: null, approvedReadings: 0, totalReadings: 0, operationalEfficiency: null, productionAvailable: false, activeCustomers: 0, representedPeople: 0, avgPerCapitaLpd: null, monthlyTrend: [], consumptionTrend: [], productionTrend: [], nrwTrend: [], financialTrend: [], workflow: { pending: 0, approved: 0, rejected: 0 }, alerts: [] };

const num = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : null;
const day = (d: Date) => d.toISOString().slice(0, 10);
const fmtDay = (s: string) => new Intl.DateTimeFormat("ar-YE", { day: "numeric", month: "short" }).format(new Date(`${s}T00:00:00`));
const pct = (v: number | null) => v == null ? "غير متاح" : `${v.toFixed(1)}%`;

async function loadMetrics(): Promise<Metrics> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));
  const end = new Date(now); end.setUTCDate(end.getUTCDate() + 1); end.setUTCHours(0, 0, 0, 0);
  const startIso = start.toISOString(); const endIso = end.toISOString();
  const { data: tenantId, error: tenantError } = await supabase.rpc("current_tenant_id");
  if (tenantError) throw tenantError; if (!tenantId) throw new Error("لا يوجد مشروع مرتبط بالحساب");
  const [tenant, r, b, p, prod, customers] = await Promise.all([
    supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
    supabase.from("water_readings").select("id,consumption,current_reading,previous,status,verification_status,created_at").eq("tenant_id", tenantId).gte("created_at", startIso).lt("created_at", endIso),
    supabase.from("water_bills").select("id,reading_id,total,status,issued_at").eq("tenant_id", tenantId).gte("issued_at", startIso).lt("issued_at", endIso),
    supabase.from("payments").select("id,bill_id,amount,status,created_at").eq("tenant_id", tenantId).gte("created_at", startIso).lt("created_at", endIso),
    supabase.from("water_production_logs").select("id,production_m3,recorded_at,capture_source,verification_status").eq("tenant_id", tenantId).gte("recorded_at", startIso).lt("recorded_at", endIso),
    supabase.from("customers").select("id,household_size,status").eq("tenant_id", tenantId).eq("status", "active"),
  ]);
  const error = [tenant, r, b, p, prod, customers].find((x) => x.error)?.error; if (error) throw error;
  const readings = (r.data ?? []) as Reading[]; const bills = (b.data ?? []) as Bill[]; const payments = (p.data ?? []) as Payment[]; const production = (prod.data ?? []) as Production[]; const customerRows = (customers.data ?? []) as Array<{ id: string; household_size: number; status: string }>; const alerts: string[] = [];
  const validReadings = readings.filter((x) => num(x.current_reading) != null && num(x.previous) != null && num(x.consumption) != null);
  const approvedReadings = validReadings.filter((x) => x.verification_status === "approved" && x.status === "approved" && Number(x.consumption) >= 0);
  const approvedIds = new Set(approvedReadings.map((x) => x.id));
  const eligibleBills = bills.filter((x) => num(x.total) != null && Number(x.total) >= 0 && x.reading_id != null && approvedIds.has(x.reading_id));
  const eligibleBillIds = new Set(eligibleBills.map((x) => x.id));
  const eligibleBilled = eligibleBills.reduce((s, x) => s + Number(x.total), 0);
  const approvedPayments = payments.filter((x) => x.status === "approved" && num(x.amount) != null && Number(x.amount) >= 0 && eligibleBillIds.has(x.bill_id));
  const approvedPaymentTotal = approvedPayments.reduce((s, x) => s + Number(x.amount), 0);
  if (validReadings.length !== readings.length) alerts.push("توجد قراءات غير صالحة ولم تدخل في المؤشرات.");
  if (readings.some((x) => Number(x.current_reading) < Number(x.previous) || Number(x.consumption) < 0)) alerts.push("توجد قراءات متناقصة/سالبة ولم تدخل في الاستهلاك المعتمد.");
  const paidWithoutLedger = bills.filter((x) => x.status === "paid" && !approvedPayments.some((p) => p.bill_id === x.id));
  if (paidWithoutLedger.length) alerts.push(`توجد ${paidWithoutLedger.length} فاتورة بحالة مدفوعة دون دفعة معتمدة؛ لم تُحتسب كتحصيل.`);
  const invalidPayments = payments.filter((x) => num(x.amount) == null || Number(x.amount) < 0);
  if (invalidPayments.length) alerts.push(`توجد ${invalidPayments.length} دفعة بقيمة غير صالحة.`);
  const validProduction = production.filter((x) => x.verification_status === "approved" && num(x.production_m3) != null && Number(x.production_m3) > 0);
  const productionAvailable = validProduction.length > 0;
  const productionInput = productionAvailable ? validProduction.reduce((s, x) => s + Number(x.production_m3), 0) : null;
  if (!productionAvailable) alerts.push("لا توجد بيانات إنتاج/ضخ موثقة ومعتمدة في آخر 30 يوماً؛ كفاءة المياه وNRW غير متاحين.");
  if (production.some((x) => x.verification_status !== "approved" && Number(x.production_m3) > 0)) alerts.push("توجد سجلات إنتاج غير معتمدة؛ تم استبعادها من المؤشرات.");
  const keys: string[] = []; const cursor = new Date(start); const last = new Date(end.getTime() - 86400000); while (cursor <= last) { keys.push(day(cursor)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  const consumptionTrend = keys.map((date) => ({ date, value: approvedReadings.filter((x) => day(new Date(x.created_at)) === date).reduce((s, x) => s + Number(x.consumption), 0) }));
  const productionTrend = keys.map((date) => ({ date, production: validProduction.filter((x) => day(new Date(x.recorded_at)) === date).reduce((s, x) => s + Number(x.production_m3), 0), consumption: consumptionTrend.find((x) => x.date === date)?.value ?? 0 }));
  const nrwTrend = productionTrend.map((x) => ({ date: x.date, value: x.production > 0 ? ((x.production - x.consumption) / x.production) * 100 : null }));
  const financialTrend = keys.map((date) => ({ date, billed: eligibleBills.filter((x) => day(new Date(x.issued_at)) === date).reduce((s, x) => s + Number(x.total), 0), collected: approvedPayments.filter((x) => day(new Date(x.created_at)) === date).reduce((s, x) => s + Number(x.amount), 0) }));
  const pending = readings.filter((x) => x.verification_status === "pending").length; const rejected = readings.filter((x) => x.verification_status === "rejected").length;
  if (pending || rejected) alerts.push(`سير العمل: ${pending} معلقة و${rejected} مرفوضة تحتاج متابعة.`);
  const approvedConsumption = approvedReadings.reduce((s, x) => s + Number(x.consumption), 0);
  const representedCustomerIds = new Set(approvedReadings.map((x) => x.customer_id).filter((x): x is string => Boolean(x)));
  const representedPeople = customerRows.filter((x) => representedCustomerIds.has(x.id)).reduce((s, x) => s + Math.max(1, Number(x.household_size) || 1), 0);
  const avgPerCapitaLpd = representedPeople > 0 ? approvedConsumption * 1000 / (representedPeople * Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000))) : null;
  const monthKeys: string[] = [];
  const monthCursor = new Date(start);
  while (monthCursor < end) {
    monthKeys.push(`${monthCursor.getUTCFullYear()}-${String(monthCursor.getUTCMonth() + 1).padStart(2, "0")}`);
    monthCursor.setUTCMonth(monthCursor.getUTCMonth() + 1);
  }
  const monthlyTrend = monthKeys.map((month) => {
    const monthReadings = approvedReadings.filter((x) => x.created_at.slice(0, 7) === month);
    const monthProduction = validProduction.filter((x) => x.recorded_at.slice(0, 7) === month).reduce((s, x) => s + Number(x.production_m3), 0);
    const monthConsumption = monthReadings.reduce((s, x) => s + Number(x.consumption), 0);
    const monthBills = eligibleBills.filter((x) => x.issued_at.slice(0, 7) === month).reduce((s, x) => s + Number(x.total), 0);
    const monthCollected = approvedPayments.filter((x) => x.created_at.slice(0, 7) === month).reduce((s, x) => s + Number(x.amount), 0);
    return { month, consumption: monthConsumption, production: monthProduction, nrw: monthProduction > 0 ? (monthProduction - monthConsumption) / monthProduction * 100 : null, billed: monthBills, collected: monthCollected };
  });
  return { tenantName: tenant.data?.name ?? "المشروع الحالي", windowStart: startIso, windowEnd: new Date(end.getTime() - 1).toISOString(), approvedConsumption, productionInput, waterEfficiency: productionInput && productionInput > 0 ? approvedConsumption / productionInput * 100 : null, meteredBalanceGap: productionInput && productionInput > 0 ? (productionInput - approvedConsumption) / productionInput * 100 : null, approvedPayments: approvedPaymentTotal, eligibleBilled, collectionRate: eligibleBilled > 0 ? approvedPaymentTotal / eligibleBilled * 100 : null, approvedReadings: approvedReadings.length, totalReadings: readings.length, operationalEfficiency: readings.length ? approvedReadings.length / readings.length * 100 : null, productionAvailable, activeCustomers: customerRows.length, representedPeople, avgPerCapitaLpd, monthlyTrend, consumptionTrend, productionTrend, nrwTrend, financialTrend, workflow: { pending, approved: approvedReadings.length, rejected }, alerts };
}

function Dashboard() {
  const { user } = useAuth(); const [m, setM] = useState(empty); const [loading, setLoading] = useState(true); const [refreshing, setRefreshing] = useState(false); const [error, setError] = useState<string | null>(null); const [live, setLive] = useState(false);
  const refresh = useCallback(async () => { setRefreshing(true); try { setError(null); setM(await loadMetrics()); } catch (e) { console.error(e); setError("تعذر تحميل مؤشرات لوحة الاستدامة من قاعدة البيانات."); } finally { setLoading(false); setRefreshing(false); } }, []);
  useEffect(() => { void refresh(); const c = supabase.channel("mizan-dashboard").on("postgres_changes", { event: "*", schema: "public", table: "water_readings" }, () => void refresh()).on("postgres_changes", { event: "*", schema: "public", table: "water_bills" }, () => void refresh()).on("postgres_changes", { event: "*", schema: "public", table: "payments" }, () => void refresh()).on("postgres_changes", { event: "*", schema: "public", table: "water_production_logs" }, () => void refresh()).subscribe((s) => setLive(s === "SUBSCRIBED")); return () => { void supabase.removeChannel(c); }; }, [refresh]);
  const period = useMemo(() => m.windowStart ? `${new Intl.DateTimeFormat("ar-YE", { day: "numeric", month: "long" }).format(new Date(m.windowStart))} — ${new Intl.DateTimeFormat("ar-YE", { day: "numeric", month: "long", year: "numeric" }).format(new Date(m.windowEnd))}` : "آخر 30 يوماً");
  if (!user?.tenantId || user.isSuperAdmin) return <div dir="rtl"><Card><CardContent className="p-8 text-center"><ShieldAlert className="mx-auto h-10 w-10"/><h1 className="mt-4 font-bold">لا يوجد مشروع مرتبط بالحساب</h1><p className="mt-2 text-sm text-muted-foreground">لا يتم عرض بيانات مشاريع أخرى أو بيانات اصطناعية.</p></CardContent></Card></div>;
  const cards = [
    ["كفاءة استخدام المياه", pct(m.waterEfficiency), "الاستهلاك المعتمد ÷ الإنتاج/مدخل النظام المعتمد × 100", <Droplets className="h-5 w-5" />],
    ["فجوة الرصيد المائي المقاسة", pct(m.meteredBalanceGap), "مدخل النظام − الاستهلاك المعتمد؛ ليست NRW معتمدة ما لم تتوفر مكونات الاستهلاك المصرح به والخسائر الظاهرية والحقيقية", <TrendingDown className="h-5 w-5" />],
    ["نسبة التحصيل", pct(m.collectionRate), "المدفوعات المعتمدة ÷ الفواتير المؤهلة × 100", <Wallet className="h-5 w-5" />],
    ["الكفاءة التشغيلية", pct(m.operationalEfficiency), "القراءات المعتمدة ÷ إجمالي القراءات × 100", <CheckCircle2 className="h-5 w-5" />], ["متوسط استهلاك الفرد", m.avgPerCapitaLpd == null ? "غير متاح" : `${m.avgPerCapitaLpd.toFixed(1)} لتر/فرد/يوم`, `${m.representedPeople} فرداً ممثلاً بقراءات معتمدة`, <Droplets className="h-5 w-5" />],
  ];
  return <div dir="rtl" className="space-y-6 pb-8">
    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"><div><Badge variant="outline" className="mb-2">لوحة الاستدامة</Badge><h1 className="text-2xl md:text-3xl font-bold">المياه والمال والتشغيل</h1><p className="mt-1 text-sm text-muted-foreground">{m.tenantName} · نافذة موحدة: {period}</p></div><div className="flex gap-2"><Badge variant="outline">{live ? "مباشر" : "غير متصل لحظياً"}</Badge><Button variant="outline" onClick={() => void refresh()} disabled={refreshing}><RefreshCw className={`h-4 w-4 ms-1 ${refreshing ? "animate-spin" : ""}`}/> تحديث</Button></div></div>
    {error && <div className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{error}</div>}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{cards.map(([title, value, desc, icon]) => <Card key={String(title)}><CardContent className="p-5"><div className="h-10 w-10 rounded-xl bg-muted grid place-items-center">{icon}</div><div className="mt-5 text-xs text-muted-foreground">{title}</div><div className="mt-1 text-2xl font-bold">{value}</div><p className="mt-2 text-[11px] leading-5 text-muted-foreground">{desc}</p></CardContent></Card>)}</div>
    <div className="grid gap-4 lg:grid-cols-3"><Card><CardHeader><CardTitle>محاكاة استهلاك الأسرة</CardTitle></CardHeader><CardContent><HouseholdSimulator /></CardContent></Card><Card className="lg:col-span-2"><CardHeader><CardTitle>تنبيهات جودة البيانات</CardTitle></CardHeader><CardContent>{m.alerts.length ? <div className="space-y-2">{m.alerts.map((x) => <div key={x} className="flex gap-2 rounded-lg border p-3 text-sm"><AlertTriangle className="h-4 w-4 shrink-0"/><span>{x}</span></div>)}</div> : <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">لا توجد تنبيهات ضمن النافذة.</div>}</CardContent></Card><Card><CardHeader><CardTitle>سير العمل</CardTitle></CardHeader><CardContent className="space-y-2">{Object.entries({ "معلقة": m.workflow.pending, "معتمدة": m.workflow.approved, "مرفوضة": m.workflow.rejected }).map(([k,v]) => <div key={k} className="flex justify-between rounded-lg border p-3"><span className="text-sm text-muted-foreground">{k}</span><b>{v}</b></div>)}</CardContent></Card></div>
    <Chart title="الاتجاه الشهري للمياه والتحصيل" icon={<TrendingUp className="h-5 w-5"/>}>{m.monthlyTrend.some(x => x.consumption || x.production || x.billed || x.collected) ? <LineChart data={m.monthlyTrend}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="month"/><YAxis/><Tooltip/><Line dataKey="production" name="الإنتاج" type="monotone" stroke="currentColor"/><Line dataKey="consumption" name="الاستهلاك" type="monotone" stroke="currentColor"/><Line dataKey="nrw" name="فجوة الرصيد %" type="monotone" stroke="currentColor"/></LineChart> : <Empty text="لا توجد بيانات شهرية كافية."/>}</Chart><Chart title="اتجاه الاستهلاك المعتمد" icon={<TrendingUp className="h-5 w-5"/>}>{m.consumptionTrend.some(x => x.value > 0) ? <AreaChart data={m.consumptionTrend}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" tickFormatter={fmtDay}/><YAxis/><Tooltip labelFormatter={(x) => fmtDay(String(x))}/><Area dataKey="value" name="الاستهلاك" type="monotone" fill="currentColor" fillOpacity={0.12} stroke="currentColor"/></AreaChart> : <Empty text="لا توجد قراءات معتمدة في آخر 30 يوماً."/>}</Chart>
    <div className="grid gap-4 lg:grid-cols-2"><Chart title="الإنتاج مقابل الاستهلاك" icon={<Waves className="h-5 w-5"/>}>{m.productionAvailable ? <LineChart data={m.productionTrend}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" tickFormatter={fmtDay}/><YAxis/><Tooltip/><Line dataKey="production" name="الإنتاج" type="monotone" stroke="currentColor"/><Line dataKey="consumption" name="الاستهلاك" type="monotone" stroke="currentColor"/></LineChart> : <ProductionUnavailable/>}</Chart><Chart title="اتجاه فجوة الرصيد المائي المقاسة" icon={<TrendingDown className="h-5 w-5"/>}>{m.productionAvailable ? <LineChart data={m.nrwTrend}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" tickFormatter={fmtDay}/><YAxis/><Tooltip/><Line dataKey="value" name="فجوة الرصيد %" type="monotone" stroke="currentColor" connectNulls={false}/></LineChart> : <ProductionUnavailable/>}</Chart></div>
    <Chart title="المفوتر مقابل المحصل فعلياً" icon={<CircleDollarSign className="h-5 w-5"/>}>{m.financialTrend.some(x => x.billed || x.collected) ? <BarChart data={m.financialTrend}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" tickFormatter={fmtDay}/><YAxis/><Tooltip formatter={(v: number) => fmtYER(v)}/><Bar dataKey="billed" name="مفوتر" fill="currentColor" fillOpacity={0.35}/><Bar dataKey="collected" name="محصل فعلياً" fill="currentColor" fillOpacity={0.8}/></BarChart> : <Empty text="لا توجد فواتير مؤهلة أو دفعات معتمدة."/>}</Chart>
    <div className="text-xs leading-5 text-muted-foreground">المصدر الوحيد للمؤشرات: Supabase. العزل يعتمد على الهوية وRLS؛ Realtime يعيد القراءة فقط ولا يمثل صلاحية. لا تستخدم لوحة التحكم Zustand أو localStorage كمصدر حقيقة.</div>{loading && <p className="text-center text-xs text-muted-foreground">جارٍ التحميل…</p>}
  </div>;
}
function Chart({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <Card><CardHeader><CardTitle className="flex items-center gap-2">{icon}{title}</CardTitle></CardHeader><CardContent className="h-72">{typeof children === "object" && children ? <ResponsiveContainer width="100%" height="100%">{children as React.ReactElement}</ResponsiveContainer> : children}</CardContent></Card>; }
function Empty({ text }: { text: string }) { return <div className="h-full grid place-items-center rounded-xl border border-dashed text-sm text-muted-foreground">{text}</div>; }
function ProductionUnavailable() { return <div className="h-full flex flex-col items-center justify-center rounded-xl border border-dashed p-5 text-center"><Waves className="h-8 w-8 text-muted-foreground"/><b className="mt-3">غير متاح</b><p className="mt-1 text-sm text-muted-foreground">لا توجد بيانات إنتاج/ضخ معتمدة وصالحة في آخر 30 يوماً.</p></div>; }

function HouseholdSimulator() {
  const [people, setPeople] = useState("10");
  const [volume, setVolume] = useState("10");
  const [result, setResult] = useState<{litres_per_person_day:number;category:string;message:string}|null>(null);
  async function simulate() {
    const household = Number(people); const consumption = Number(volume);
    if (!Number.isInteger(household) || household < 1 || household > 100 || !Number.isFinite(consumption) || consumption < 0) return;
    const { data, error } = await supabase.rpc("simulate_household_water_use", { p_household_size: household, p_consumption_m3: consumption, p_days: 30 });
    if (error) return;
    setResult(data as {litres_per_person_day:number;category:string;message:string});
  }
  return <div className="space-y-3"><div className="grid grid-cols-2 gap-3"><div><label className="text-xs text-muted-foreground">أفراد الأسرة</label><input className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm" type="number" min="1" max="100" value={people} onChange={e=>setPeople(e.target.value)}/></div><div><label className="text-xs text-muted-foreground">الاستهلاك الشهري (م³)</label><input className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm" type="number" min="0" step="0.01" value={volume} onChange={e=>setVolume(e.target.value)}/></div></div><Button size="sm" onClick={()=>void simulate()}>احسب</Button>{result&&<div className="rounded-lg border p-3 text-sm"><b>{result.litres_per_person_day.toFixed(1)} لتر/فرد/يوم</b><p className="mt-1 text-muted-foreground">{result.message}</p></div>}<p className="text-[11px] text-muted-foreground">المرجع: 20 لتر/فرد/يوم حد أساسي، نحو 50 مستوى متوسط، و100+ مستوى أمثل وفق WHO. هذه مؤشرات خدمة وليست حداً قانونياً.</p></div>;
}
