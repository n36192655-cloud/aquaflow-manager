import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Droplets,
  RefreshCw,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Wallet,
  Waves,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { fmtYER } from "@/lib/pricing";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "لوحة الاستدامة — منصة ميزان لإستدامة خدمات المياه" }] }),
  component: Dashboard,
});

type ReadingRow = {
  id: string;
  consumption: number;
  current_reading: number;
  previous: number;
  flag: string;
  status: string;
  created_at: string;
};

type BillRow = {
  id: string;
  reading_id: string | null;
  total: number;
  status: string;
  issued_at: string;
};

type PaymentRow = {
  id: string;
  bill_id: string;
  amount: number;
  status: string;
  created_at: string;
};

type Metrics = {
  tenantName: string;
  windowStart: string;
  windowEnd: string;
  approvedConsumption: number;
  waterEfficiency: number | null;
  nrw: number | null;
  approvedPayments: number;
  eligibleBilled: number;
  collectionRate: number | null;
  approvedReadings: number;
  totalReadings: number;
  operationalEfficiency: number | null;
  productionAvailable: false;
  consumptionTrend: Array<{ date: string; value: number }>;
  financialTrend: Array<{ date: string; billed: number; collected: number }>;
  workflow: { pending: number; approved: number; rejected: number };
  alerts: string[];
};

const emptyMetrics: Metrics = {
  tenantName: "",
  windowStart: "",
  windowEnd: "",
  approvedConsumption: 0,
  waterEfficiency: null,
  nrw: null,
  approvedPayments: 0,
  eligibleBilled: 0,
  collectionRate: null,
  approvedReadings: 0,
  totalReadings: 0,
  operationalEfficiency: null,
  productionAvailable: false,
  consumptionTrend: [],
  financialTrend: [],
  workflow: { pending: 0, approved: 0, rejected: 0 },
  alerts: [],
};

function toFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat("ar-YE", { day: "numeric", month: "short" }).format(new Date(`${value}T00:00:00`));
}

function formatPercent(value: number | null): string {
  return value == null ? "غير متاح" : `${value.toFixed(1)}%`;
}

function buildDateKeys(start: Date, end: Date): string[] {
  const keys: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    keys.push(dateKey(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

async function loadMetrics(): Promise<Metrics> {
  const now = new Date();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 29);
  start.setUTCHours(0, 0, 0, 0);
  const startIso = start.toISOString();
  const endExclusive = new Date(now);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  endExclusive.setUTCHours(0, 0, 0, 0);
  const endIso = endExclusive.toISOString();

  // The tenant comes from the authenticated server-authoritative identity, not from client input.
  const { data: tenantId, error: tenantError } = await supabase.rpc("current_tenant_id");
  if (tenantError) throw tenantError;
  if (!tenantId) throw new Error("لا يوجد مستأجر مرتبط بالحساب المصادق عليه");

  const [tenantResult, readingsResult, billsResult, paymentsResult] = await Promise.all([
    supabase.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
    supabase
      .from("water_readings")
      .select("id,consumption,current_reading,previous,flag,status,created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", startIso)
      .lt("created_at", endIso),
    supabase
      .from("water_bills")
      .select("id,reading_id,total,status,issued_at")
      .eq("tenant_id", tenantId)
      .gte("issued_at", startIso)
      .lt("issued_at", endIso),
    supabase
      .from("payments")
      .select("id,bill_id,amount,status,created_at")
      .eq("tenant_id", tenantId)
      .gte("created_at", startIso)
      .lt("created_at", endIso),
  ]);

  if (tenantResult.error) throw tenantResult.error;
  if (readingsResult.error) throw readingsResult.error;
  if (billsResult.error) throw billsResult.error;
  if (paymentsResult.error) throw paymentsResult.error;

  const readings = (readingsResult.data ?? []) as ReadingRow[];
  const bills = (billsResult.data ?? []) as BillRow[];
  const payments = (paymentsResult.data ?? []) as PaymentRow[];
  const alerts: string[] = [];

  const validReadings = readings.filter(
    (reading) =>
      toFiniteNumber(reading.current_reading) != null &&
      toFiniteNumber(reading.previous) != null &&
      toFiniteNumber(reading.consumption) != null,
  );
  if (validReadings.length !== readings.length) alerts.push("توجد قراءات بقيم غير صالحة أو غير رقمية ضمن الفترة.");

  const approvedReadings = validReadings.filter((reading) => reading.status === "approved" && Number(reading.consumption) >= 0);
  const negativeReadings = readings.filter(
    (reading) => Number(reading.current_reading) < Number(reading.previous) || Number(reading.consumption) < 0,
  );
  if (negativeReadings.length > 0) {
    alerts.push(`توجد ${negativeReadings.length} قراءة سالبة/متناقصة ضمن الفترة وتم إبقاؤها ظاهرة كجودة بيانات.`);
  }

  const approvedReadingIds = new Set(approvedReadings.map((reading) => reading.id));
  const eligibleBills = bills.filter((bill) => {
    const total = toFiniteNumber(bill.total);
    return total != null && total >= 0 && bill.reading_id != null && approvedReadingIds.has(bill.reading_id);
  });
  const eligibleBillIds = new Set(eligibleBills.map((bill) => bill.id));
  const eligibleBilled = eligibleBills.reduce((sum, bill) => sum + Number(bill.total), 0);

  const approvedPayments = payments.filter((payment) => {
    const amount = toFiniteNumber(payment.amount);
    return payment.status === "approved" && amount != null && amount >= 0 && eligibleBillIds.has(payment.bill_id);
  });
  const approvedPaymentTotal = approvedPayments.reduce((sum, payment) => sum + Number(payment.amount), 0);

  const paidBillIds = new Set(approvedPayments.map((payment) => payment.bill_id));
  const paidWithoutLedger = bills.filter((bill) => bill.status === "paid" && !paidBillIds.has(bill.id));
  if (paidWithoutLedger.length > 0) {
    alerts.push(`توجد ${paidWithoutLedger.length} فاتورة تحمل حالة paid دون وجود قيد دفع معتمد مطابق في payment ledger؛ لم تُحتسب كتحصيل نقدي.`);
  }

  const invalidPayments = payments.filter((payment) => toFiniteNumber(payment.amount) == null || Number(payment.amount) < 0);
  if (invalidPayments.length > 0) alerts.push(`توجد ${invalidPayments.length} دفعة بقيمة غير صالحة.`);

  const unlinkedPayments = payments.filter((payment) => !bills.some((bill) => bill.id === payment.bill_id));
  if (unlinkedPayments.length > 0) {
    alerts.push(`توجد ${unlinkedPayments.length} دفعة لا يمكن ربطها بفواتير مرئية ضمن tenant الحالي؛ لم تُحتسب.`);
  }

  const dates = buildDateKeys(start, new Date(endExclusive.getTime() - 86_400_000));
  const consumptionTrend = dates.map((date) => ({
    date,
    value: approvedReadings
      .filter((reading) => dateKey(new Date(reading.created_at)) === date)
      .reduce((sum, reading) => sum + Number(reading.consumption), 0),
  }));

  const financialTrend = dates.map((date) => ({
    date,
    billed: eligibleBills
      .filter((bill) => dateKey(new Date(bill.issued_at)) === date)
      .reduce((sum, bill) => sum + Number(bill.total), 0),
    collected: approvedPayments
      .filter((payment) => dateKey(new Date(payment.created_at)) === date)
      .reduce((sum, payment) => sum + Number(payment.amount), 0),
  }));

  const pending = readings.filter((reading) => reading.status === "pending").length;
  const rejected = readings.filter((reading) => reading.status === "rejected").length;
  const approved = readings.filter((reading) => reading.status === "approved").length;
  if (pending > 0 || rejected > 0) {
    alerts.push(`سير العمل: ${pending} قراءة معلقة و${rejected} قراءة مرفوضة تحتاجان إلى متابعة.`);
  }

  // Dashboard intentionally reads the authoritative Supabase tables directly.
  // readings.tsx and payments.tsx still use the local Zustand store; this is a
  // known Source-of-Truth mismatch and is not treated as DB-backed workflow.
  return {
    tenantName: tenantResult.data?.name ?? "المشروع الحالي",
    windowStart: startIso,
    windowEnd: new Date(endExclusive.getTime() - 1).toISOString(),
    approvedConsumption: approvedReadings.reduce((sum, reading) => sum + Number(reading.consumption), 0),
    waterEfficiency: null,
    nrw: null,
    approvedPayments: approvedPaymentTotal,
    eligibleBilled,
    collectionRate: eligibleBilled > 0 ? (approvedPaymentTotal / eligibleBilled) * 100 : null,
    approvedReadings: approvedReadings.length,
    totalReadings: readings.length,
    operationalEfficiency: readings.length > 0 ? (approvedReadings.length / readings.length) * 100 : null,
    productionAvailable: false,
    consumptionTrend,
    financialTrend,
    workflow: { pending, approved, rejected },
    alerts,
  };
}

function Dashboard() {
  const { user } = useAuth();
  const [metrics, setMetrics] = useState<Metrics>(emptyMetrics);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setError(null);
      setMetrics(await loadMetrics());
    } catch (cause) {
      console.error("[Mizan] dashboard refresh failed", cause);
      setError("تعذر تحميل مؤشرات لوحة الاستدامة من قاعدة البيانات.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const channel = supabase
      .channel("mizan-dashboard")
      .on("postgres_changes", { event: "*", schema: "public", table: "water_readings" }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "water_bills" }, () => void refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, () => void refresh())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  const periodLabel = useMemo(() => {
    if (!metrics.windowStart) return "آخر 30 يوماً";
    return `${new Intl.DateTimeFormat("ar-YE", { day: "numeric", month: "long" }).format(new Date(metrics.windowStart))} — ${new Intl.DateTimeFormat("ar-YE", { day: "numeric", month: "long", year: "numeric" }).format(new Date(metrics.windowEnd))}`;
  }, [metrics.windowEnd, metrics.windowStart]);

  const kpis = [
    {
      title: "كفاءة استخدام المياه",
      value: formatPercent(metrics.waterEfficiency),
      description: "الاستهلاك المعتمد ÷ الإنتاج/الضخ",
      icon: <Droplets className="h-5 w-5" />,
      unavailable: !metrics.productionAvailable,
    },
    {
      title: "فاقد المياه NRW",
      value: formatPercent(metrics.nrw),
      description: "(الإنتاج − الاستهلاك المعتمد) ÷ الإنتاج",
      icon: <TrendingDown className="h-5 w-5" />,
      unavailable: !metrics.productionAvailable,
    },
    {
      title: "الاستدامة المالية / نسبة التحصيل",
      value: formatPercent(metrics.collectionRate),
      description: "المدفوعات المعتمدة ÷ الفواتير المؤهلة",
      icon: <Wallet className="h-5 w-5" />,
      unavailable: metrics.collectionRate == null,
    },
    {
      title: "الكفاءة التشغيلية",
      value: formatPercent(metrics.operationalEfficiency),
      description: "القراءات المعتمدة ÷ إجمالي القراءات",
      icon: <CheckCircle2 className="h-5 w-5" />,
      unavailable: metrics.operationalEfficiency == null,
    },
  ];

  if (user?.isSuperAdmin || !user?.tenantId) {
    return (
      <div dir="rtl" className="space-y-6">
        <Card>
          <CardContent className="p-8 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-muted-foreground" />
            <h1 className="mt-4 text-xl font-bold">لا يوجد مشروع مرتبط بالحساب</h1>
            <p className="mt-2 text-sm text-muted-foreground">لوحة الاستدامة لا تجمع بيانات عدة مشاريع. يجب ربط الحساب بـ tenant قبل عرض المؤشرات.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div dir="rtl" className="space-y-6 pb-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <Badge variant="outline" className="mb-2">لوحة الاستدامة</Badge>
          <h1 className="text-2xl font-bold md:text-3xl">المياه والمال والتشغيل</h1>
          <p className="mt-1 text-sm text-muted-foreground">{metrics.tenantName} · نافذة موحدة: {periodLabel}</p>
        </div>
        <Button variant="outline" onClick={() => void refresh()} disabled={refreshing} className="gap-2 self-start">
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> تحديث البيانات
        </Button>
      </div>

      {error && <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => (
          <Card key={kpi.title} className={kpi.unavailable ? "border-dashed" : ""}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted">{kpi.icon}</div>
                {kpi.unavailable && <Badge variant="secondary">غير متاح</Badge>}
              </div>
              <div className="mt-5 text-xs text-muted-foreground">{kpi.title}</div>
              <div className="mt-1 text-2xl font-bold tracking-tight">{kpi.value}</div>
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{kpi.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader><CardTitle>تنبيه مهم لجودة البيانات</CardTitle></CardHeader>
          <CardContent>
            {!metrics.productionAvailable && (
              <div className="rounded-xl border border-dashed p-5">
                <div className="flex items-start gap-3">
                  <Waves className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="font-semibold">بيانات الإنتاج/الضخ غير متوفرة للفترة المحددة.</p>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">لم يتم إنشاء بيانات تقديرية. إدخال سجلات الإنتاج/الضخ الفعلية لنفس tenant والفترة سيُفعّل NRW وكفاءة استخدام المياه ومقارنة الإنتاج مقابل الاستهلاك.</p>
                  </div>
                </div>
              </div>
            )}
            {metrics.alerts.length > 0 && (
              <div className="mt-4 space-y-2">
                {metrics.alerts.map((alert) => (
                  <div key={alert} className="flex gap-2 rounded-lg border bg-muted/20 p-3 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{alert}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>سير العمل</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <WorkflowRow label="معلقة" value={metrics.workflow.pending} />
            <WorkflowRow label="معتمدة" value={metrics.workflow.approved} />
            <WorkflowRow label="مرفوضة" value={metrics.workflow.rejected} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5" /> اتجاه الاستهلاك المعتمد · آخر 30 يوماً</CardTitle></CardHeader>
        <CardContent className="h-72">
          {metrics.consumptionTrend.some((point) => point.value > 0) ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={metrics.consumptionTrend} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tickFormatter={formatDay} minTickGap={24} />
                <YAxis />
                <Tooltip labelFormatter={(label) => formatDay(String(label))} formatter={(value: number) => [`${value.toFixed(2)} م³`, "الاستهلاك"]} />
                <Area type="monotone" dataKey="value" fill="currentColor" fillOpacity={0.12} stroke="currentColor" />
              </AreaChart>
            </ResponsiveContainer>
          ) : <EmptyChart text="لا توجد قراءات معتمدة في آخر 30 يوماً." />}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>الإنتاج مقابل الاستهلاك</CardTitle></CardHeader><CardContent><ProductionEmptyState /></CardContent></Card>
        <Card><CardHeader><CardTitle>اتجاه NRW</CardTitle></CardHeader><CardContent><ProductionEmptyState /></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><CircleDollarSign className="h-5 w-5" /> المبالغ المفوترة مقابل المحصلة فعلياً</CardTitle></CardHeader>
        <CardContent className="h-72">
          {metrics.financialTrend.some((point) => point.billed > 0 || point.collected > 0) ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={metrics.financialTrend} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" tickFormatter={formatDay} minTickGap={24} />
                <YAxis />
                <Tooltip labelFormatter={(label) => formatDay(String(label))} formatter={(value: number, name: string) => [fmtYER(value), name === "billed" ? "مفوتر" : "محصل فعلياً"]} />
                <Bar dataKey="billed" name="billed" fill="currentColor" fillOpacity={0.35} />
                <Bar dataKey="collected" name="collected" fill="currentColor" fillOpacity={0.8} />
              </BarChart>
            </ResponsiveContainer>
          ) : <EmptyChart text="لا توجد فواتير مؤهلة أو مدفوعات معتمدة في الفترة." />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>حالة سير العمل · pending / approved / rejected</CardTitle></CardHeader>
        <CardContent className="h-72">
          {metrics.totalReadings > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={[metrics.workflow]} margin={{ top: 20, right: 20, left: 20, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey={() => "آخر 30 يوماً"} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="pending" name="معلقة" stroke="currentColor" />
                <Line type="monotone" dataKey="approved" name="معتمدة" stroke="currentColor" />
                <Line type="monotone" dataKey="rejected" name="مرفوضة" stroke="currentColor" />
              </LineChart>
            </ResponsiveContainer>
          ) : <EmptyChart text="لا توجد قراءات في النافذة الحالية." />}
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground">مصدر لوحة الاستدامة: Supabase فقط، مع فرض tenant من الهوية الحالية عبر RLS. Realtime يسرّع التحديث لكنه ليس بديلاً عن RLS.</div>
      {loading && <p className="text-center text-xs text-muted-foreground">جارٍ تحميل بيانات آخر 30 يوماً…</p>}
    </div>
  );
}

function WorkflowRow({ label, value }: { label: string; value: number }) {
  return <div className="flex items-center justify-between rounded-lg border p-3"><span className="text-sm text-muted-foreground">{label}</span><span className="font-bold">{value}</span></div>;
}

function EmptyChart({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">{text}</div>;
}

function ProductionEmptyState() {
  return <div className="rounded-xl border border-dashed p-6 text-center"><Waves className="mx-auto h-8 w-8 text-muted-foreground" /><p className="mt-3 font-semibold">غير متاح</p><p className="mt-1 text-sm leading-6 text-muted-foreground">بيانات الإنتاج/الضخ غير متوفرة للفترة المحددة. لم يتم إنشاء بيانات اصطناعية لإظهار المؤشر.</p></div>;
}
