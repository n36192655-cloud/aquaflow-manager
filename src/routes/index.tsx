import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { fmtYER, fmtNum } from "@/lib/pricing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Droplets, Users, AlertTriangle, Percent, HelpCircle, RefreshCw } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
  Legend,
  LineChart,
  Line,
} from "recharts";

export const Route = createFileRoute("/")({
  component: Dashboard,
  head: () => ({
    meta: [
      { title: "لوحة تحكم ميزان — إدارة مشاريع المياه" },
      {
        name: "description",
        content:
          "مؤشرات المشتركين وكفاءة التحصيل والاستهلاك المعتمد وسلامة القراءات لمشروع المياه، محدثة تلقائياً.",
      },
      { property: "og:title", content: "لوحة تحكم ميزان — إدارة مشاريع المياه" },
      {
        property: "og:description",
        content:
          "مؤشرات المشتركين وكفاءة التحصيل والاستهلاك المعتمد وسلامة القراءات لمشروع المياه.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

const WINDOW_DAYS = 30;

interface DashboardData {
  tenantId: string | null;
  customersTotal: number;
  customersActive: number;
  billedTotal: number;
  collectedTotal: number;
  billsCount: number;
  paidBills: number;
  unpaidBills: number;
  overdueBills: number;
  approvedConsumption: number;
  approvedReadings: number;
  pendingReadings: number;
  flaggedReadings: number;
  flagBreakdown: { name: string; value: number }[];
  paymentsCount: number;
  trend: { day: string; consumption: number; readings: number }[];
  fetchedAt: string;
}

async function loadDashboard(): Promise<DashboardData> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  let tenantId: string | null = null;
  if (uid) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("tenant_id")
      .eq("id", uid)
      .maybeSingle();
    tenantId = profile?.tenant_id ?? null;
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();

  // RLS already restricts every row to the caller's tenant.
  const [customers, readings, bills, payments] = await Promise.all([
    supabase.from("customers").select("id,status"),
    supabase
      .from("water_readings")
      .select("id,consumption,status,flag,created_at")
      .gte("created_at", since),
    supabase.from("water_bills").select("id,total,status,issued_at"),
    supabase.from("payments").select("id,amount,status,bill_id"),
  ]);

  const err = customers.error ?? readings.error ?? bills.error ?? payments.error;
  if (err) throw new Error(err.message);

  const rows = readings.data ?? [];
  const approved = rows.filter((r) => r.status === "approved");
  const flagged = rows.filter((r) => r.flag && r.flag !== "ok");

  const flagMap = new Map<string, number>();
  flagged.forEach((r) => flagMap.set(r.flag!, (flagMap.get(r.flag!) ?? 0) + 1));

  const dayMap = new Map<string, { consumption: number; readings: number }>();
  approved.forEach((r) => {
    const day = (r.created_at ?? "").slice(0, 10);
    const cur = dayMap.get(day) ?? { consumption: 0, readings: 0 };
    cur.consumption += Number(r.consumption ?? 0);
    cur.readings += 1;
    dayMap.set(day, cur);
  });

  const billRows = bills.data ?? [];
  const payRows = (payments.data ?? []).filter((p) => p.status === "approved");
  const now = Date.now();

  return {
    tenantId,
    customersTotal: (customers.data ?? []).length,
    customersActive: (customers.data ?? []).filter((c) => c.status === "active").length,
    billedTotal: billRows.reduce((a, b) => a + Number(b.total ?? 0), 0),
    collectedTotal: payRows.reduce((a, b) => a + Number(b.amount ?? 0), 0),
    billsCount: billRows.length,
    paidBills: billRows.filter((b) => b.status === "paid").length,
    unpaidBills: billRows.filter((b) => b.status !== "paid").length,
    overdueBills: billRows.filter(
      (b) =>
        b.status !== "paid" && b.issued_at && now - new Date(b.issued_at).getTime() > 30 * 86400000,
    ).length,
    approvedConsumption: approved.reduce((a, b) => a + Number(b.consumption ?? 0), 0),
    approvedReadings: approved.length,
    pendingReadings: rows.filter((r) => r.status === "pending").length,
    flaggedReadings: flagged.length,
    flagBreakdown: [...flagMap.entries()].map(([name, value]) => ({ name, value })),
    paymentsCount: payRows.length,
    trend: [...dayMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({ day, ...v })),
    fetchedAt: new Date().toISOString(),
  };
}

function Dashboard() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["dashboard"],
    queryFn: loadDashboard,
    staleTime: 15_000,
  });
  const tenantId = data?.tenantId ?? null;
  const [live, setLive] = useState<"connecting" | "live" | "off">("connecting");

  // Realtime على جداول قاعدة البيانات، مقيّد بالـ tenant الحالي + debounce
  useEffect(() => {
    if (!tenantId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => qc.invalidateQueries({ queryKey: ["dashboard"] }), 600);
    };
    const channel = supabase.channel(`dashboard:${tenantId}`);
    (["water_readings", "water_bills", "payments", "customers"] as const).forEach((table) => {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `tenant_id=eq.${tenantId}` },
        bump,
      );
    });
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") setLive("live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED")
        setLive("off");
    });
    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [tenantId, qc]);

  const collection = useMemo(() => {
    if (!data || data.billedTotal <= 0) return null;
    return (data.collectedTotal / data.billedTotal) * 100;
  }, [data]);

  if (isLoading) {
    return (
      <div className="space-y-6" dir="rtl">
        <Skeleton className="h-9 w-64" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card dir="rtl">
        <CardHeader>
          <CardTitle>تعذر تحميل بيانات اللوحة</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>{(error as Error)?.message ?? "خطأ غير معروف"}</p>
          <Button onClick={() => refetch()} size="sm">
            إعادة المحاولة
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data.tenantId) {
    return (
      <Card dir="rtl">
        <CardHeader>
          <CardTitle>غير متاح — لا يوجد مشروع مرتبط بحسابك</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          يجب ربط حسابك بمشروع مياه (tenant) لعرض المؤشرات الإنتاجية من قاعدة البيانات.
        </CardContent>
      </Card>
    );
  }

  const empty = data.customersTotal === 0 && data.billsCount === 0 && data.approvedReadings === 0;

  const collectionPie = [
    { name: "مدفوعة", value: data.paidBills },
    { name: "مستحقة", value: data.unpaidBills - data.overdueBills },
    { name: "متأخرة (>30 يوم)", value: data.overdueBills },
  ].filter((s) => s.value > 0);

  const funnel = [
    { name: "قراءات معتمدة", value: data.approvedReadings },
    { name: "فواتير", value: data.billsCount },
    { name: "مدفوعات معتمدة", value: data.paymentsCount },
  ];

  return (
    <TooltipProvider>
      <div className="space-y-6" dir="rtl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">لوحة التحكم</h1>
            <p className="text-sm text-muted-foreground mt-1">
              المصدر: قاعدة البيانات للمشروع الحالي فقط — نافذة {WINDOW_DAYS} يوماً
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={live === "live" ? "secondary" : "outline"}>
              {live === "live"
                ? "تحديث تلقائي مباشر"
                : live === "connecting"
                  ? "جارٍ الاتصال…"
                  : "التحديث المباشر متوقف"}
            </Badge>
            <span>آخر تحديث: {new Date(data.fetchedAt).toLocaleTimeString("ar")}</span>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {empty && (
          <Card>
            <CardContent className="p-5 text-sm text-muted-foreground">
              لا توجد بيانات في قاعدة البيانات لهذا المشروع بعد. ستظهر المؤشرات تلقائياً بعد أول
              قراءة معتمدة أو فاتورة.
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi
            title="المشتركون النشطون"
            value={`${fmtNum(data.customersActive)} / ${fmtNum(data.customersTotal)}`}
            icon={<Users className="w-5 h-5" />}
            how="الجدول: customers. المعادلة: عدد الصفوف بحالة status='active' مقابل إجمالي الصفوف. بلا نافذة زمنية. الاستبعاد: لا شيء — RLS يقيّد النتائج على المشروع الحالي."
          />
          <Kpi
            title="كفاءة التحصيل"
            value={collection === null ? "غير متاح" : `${collection.toFixed(1)}%`}
            icon={<Percent className="w-5 h-5" />}
            sub={
              collection === null
                ? "لا توجد فواتير قابلة للحساب"
                : `المحصّل ${fmtYER(data.collectedTotal)} من المفوتر ${fmtYER(data.billedTotal)}`
            }
            how="الجداول: water_bills و payments. المعادلة: مجموع payments.amount (status='approved') ÷ مجموع water_bills.total × 100. لا يتم جمع المدفوعات مع الفواتير المدفوعة (لمنع الاحتساب المزدوج). غير متاح إذا كان إجمالي المفوتر = 0."
          />
          <Kpi
            title="الاستهلاك المعتمد"
            value={`${fmtNum(data.approvedConsumption)} م³`}
            icon={<Droplets className="w-5 h-5" />}
            sub={`${fmtNum(data.approvedReadings)} قراءة معتمدة`}
            how={`الجدول: water_readings. المعادلة: مجموع consumption للقراءات status='approved' فقط خلال آخر ${WINDOW_DAYS} يوماً حسب created_at. الاستبعاد: القراءات pending والمعلّقة محلياً (offline) غير محتسبة.`}
          />
          <Kpi
            title="سلامة القراءات"
            value={
              data.approvedReadings + data.pendingReadings + data.flaggedReadings === 0
                ? "لا توجد بيانات كافية"
                : `${fmtNum(data.flaggedReadings)} شاذة`
            }
            icon={<AlertTriangle className="w-5 h-5" />}
            highlight={data.flaggedReadings > 0}
            sub={`${fmtNum(data.pendingReadings)} قراءة بانتظار الاعتماد`}
            how={`الجدول: water_readings. المعادلة: عدد الصفوف التي flag <> 'ok' خلال آخر ${WINDOW_DAYS} يوماً. ملاحظة: مؤشر فاقد المياه (NRW) غير متاح لعدم وجود بيانات ضخّ/إنتاج في قاعدة البيانات الحالية.`}
          />
        </div>

        <div className="grid lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>اتجاه الاستهلاك والقراءات المعتمدة</CardTitle>
              <How
                text={`الجدول: water_readings (status='approved'). تجميع يومي حسب created_at خلال آخر ${WINDOW_DAYS} يوماً.`}
              />
            </CardHeader>
            <CardContent className="h-72">
              {data.trend.length === 0 ? (
                <Empty />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.trend}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="consumption"
                      name="استهلاك (م³)"
                      stroke="var(--water)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="readings"
                      name="عدد القراءات"
                      stroke="var(--muted-foreground)"
                      strokeWidth={1.5}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>حالة الفواتير</CardTitle>
              <How text="الجدول: water_bills. التقسيم حسب status، و«متأخرة» = غير مدفوعة ومضى على issued_at أكثر من 30 يوماً." />
            </CardHeader>
            <CardContent className="h-72">
              {collectionPie.length === 0 ? (
                <Empty />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={collectionPie}
                      dataKey="value"
                      innerRadius={55}
                      outerRadius={90}
                      paddingAngle={2}
                    >
                      <Cell fill="var(--water)" />
                      <Cell fill="var(--muted-foreground)" />
                      <Cell fill="var(--destructive)" />
                    </Pie>
                    <Tooltip formatter={(v: number) => fmtNum(v)} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>دورة العمل: قراءات ← فواتير ← مدفوعات</CardTitle>
              <How text="أعداد فعلية من water_readings (المعتمدة) و water_bills و payments (approved) للمشروع الحالي." />
            </CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={funnel}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="value" name="عدد" fill="var(--water)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>تصنيف القراءات الشاذة</CardTitle>
              <How text="الجدول: water_readings — تجميع القيم الفعلية للعمود flag عندما تختلف عن 'ok'. لا تصنيفات مضافة." />
            </CardHeader>
            <CardContent className="h-64">
              {data.flagBreakdown.length === 0 ? (
                <Empty text="لا توجد قراءات شاذة في النافذة الزمنية." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.flagBreakdown} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90} />
                    <Tooltip />
                    <Bar
                      dataKey="value"
                      name="عدد"
                      fill="var(--destructive)"
                      radius={[4, 4, 4, 4]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        <p className="text-xs text-muted-foreground">
          مؤشر فاقد المياه (NRW) غير متاح — البيانات المطلوبة (كميات الضخ/الإنتاج) غير موجودة في
          قاعدة البيانات الحالية.
        </p>
      </div>
    </TooltipProvider>
  );
}

function How({ text }: { text: string }) {
  return (
    <UITooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="كيف حُسب؟"
          className="text-muted-foreground hover:text-foreground"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-right leading-relaxed">{text}</TooltipContent>
    </UITooltip>
  );
}

function Empty({ text = "لا توجد بيانات كافية لعرض هذا التحليل." }: { text?: string }) {
  return <div className="h-full grid place-items-center text-sm text-muted-foreground">{text}</div>;
}

function Kpi({
  title,
  value,
  icon,
  sub,
  how,
  highlight,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  sub?: string;
  how: string;
  highlight?: boolean;
}) {
  return (
    <Card className={highlight ? "border-destructive/40" : undefined}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="truncate">{title}</span>
              <How text={how} />
            </div>
            <div
              className={`mt-2 text-xl md:text-2xl font-bold ${highlight ? "text-destructive" : ""}`}
            >
              {value}
            </div>
            {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
          </div>
          <div
            className="w-10 h-10 shrink-0 rounded-lg grid place-items-center"
            style={{ background: "var(--water-soft)", color: "var(--water)" }}
          >
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
