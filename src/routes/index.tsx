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
import {
  AlertTriangle,
  Droplets,
  HelpCircle,
  Percent,
  RefreshCw,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export const Route = createFileRoute("/")({
  component: Dashboard,
  head: () => ({
    meta: [
      { title: "لوحة تحكم ميزان — إدارة مشاريع المياه" },
      {
        name: "description",
        content:
          "مؤشرات الاستدامة والتشغيل والتحصيل لمشروع المياه الحالي، محسوبة من البيانات المعتمدة فقط.",
      },
    ],
  }),
});

const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * 86400000;

type ReadingRow = {
  id: string;
  consumption: number;
  previous: number;
  current_reading: number;
  status: string;
  flag: string;
  created_at: string;
};

type BillRow = {
  id: string;
  total: number;
  status: string;
  issued_at: string;
  reading_id: string | null;
};

type PaymentRow = {
  id: string;
  amount: number;
  status: string;
  bill_id: string;
  created_at: string;
};

interface DashboardData {
  tenantId: string | null;
  customersTotal: number;
  customersActive: number;
  readingsTotal: number;
  approvedReadings: number;
  pendingReadings: number;
  rejectedReadings: number;
  approvedConsumption: number;
  operationalEfficiency: number | null;
  billedTotal: number;
  collectedTotal: number;
  eligibleBills: number;
  approvedPayments: number;
  paidBillsWithoutLedger: number;
  invalidReadings: number;
  inconsistentReadings: number;
  orphanPayments: number;
  invalidPayments: number;
  collectionDataQuality: string[];
  consumptionTrend: { day: string; consumption: number }[];
  financeTrend: { day: string; billed: number; collected: number }[];
  flagBreakdown: { name: string; value: number }[];
  fetchedAt: string;
}

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

async function loadDashboard(): Promise<DashboardData> {
  const { data: tenant, error: tenantError } = await supabase.rpc("current_tenant_id");
  if (tenantError) throw new Error(`تعذر تحديد المشروع الحالي: ${tenantError.message}`);

  const tenantId = tenant ?? null;
  if (!tenantId) {
    return {
      tenantId: null,
      customersTotal: 0,
      customersActive: 0,
      readingsTotal: 0,
      approvedReadings: 0,
      pendingReadings: 0,
      rejectedReadings: 0,
      approvedConsumption: 0,
      operationalEfficiency: null,
      billedTotal: 0,
      collectedTotal: 0,
      eligibleBills: 0,
      approvedPayments: 0,
      paidBillsWithoutLedger: 0,
      invalidReadings: 0,
      inconsistentReadings: 0,
      orphanPayments: 0,
      invalidPayments: 0,
      collectionDataQuality: [],
      consumptionTrend: [],
      financeTrend: [],
      flagBreakdown: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  const [customers, readings, bills, payments] = await Promise.all([
    supabase.from("customers").select("id,status"),
    supabase
      .from("water_readings")
      .select("id,consumption,previous,current_reading,status,flag,created_at")
      .gte("created_at", since),
    supabase
      .from("water_bills")
      .select("id,total,status,issued_at,reading_id")
      .gte("issued_at", since),
    supabase
      .from("payments")
      .select("id,amount,status,bill_id,created_at")
      .gte("created_at", since),
  ]);

  const firstError = customers.error ?? readings.error ?? bills.error ?? payments.error;
  if (firstError) throw new Error(firstError.message);

  const readingRows = (readings.data ?? []) as ReadingRow[];
  const billRows = (bills.data ?? []) as BillRow[];
  const paymentRows = (payments.data ?? []) as PaymentRow[];

  const approved = readingRows.filter((r) => r.status === "approved");
  const invalidReadings = approved.filter(
    (r) => !isFiniteNonNegative(Number(r.consumption)),
  );
  const inconsistentReadings = readingRows.filter(
    (r) =>
      Number.isFinite(Number(r.previous)) &&
      Number.isFinite(Number(r.current_reading)) &&
      Number(r.current_reading) < Number(r.previous),
  );
  const validApproved = approved.filter((r) =>
    isFiniteNonNegative(Number(r.consumption)),
  );

  const eligibleBills = billRows.filter(
    (b) => b.reading_id !== null && isFiniteNonNegative(Number(b.total)),
  );
  const eligibleBillIds = new Set(eligibleBills.map((b) => b.id));

  const validApprovedPayments = paymentRows.filter(
    (p) =>
      p.status === "approved" &&
      isFiniteNonNegative(Number(p.amount)) &&
      eligibleBillIds.has(p.bill_id),
  );
  const invalidPayments = paymentRows.filter(
    (p) => p.status === "approved" && !isFiniteNonNegative(Number(p.amount)),
  ).length;
  const orphanPayments = paymentRows.filter(
    (p) =>
      p.status === "approved" &&
      isFiniteNonNegative(Number(p.amount)) &&
      !eligibleBillIds.has(p.bill_id),
  ).length;

  const collectedTotal = validApprovedPayments.reduce(
    (sum, p) => sum + Number(p.amount),
    0,
  );
  const billedTotal = eligibleBills.reduce((sum, b) => sum + Number(b.total), 0);

  const paymentByBill = new Map<string, number>();
  validApprovedPayments.forEach((p) => {
    paymentByBill.set(p.bill_id, (paymentByBill.get(p.bill_id) ?? 0) + Number(p.amount));
  });
  const paidBillsWithoutLedger = eligibleBills.filter(
    (b) => b.status === "paid" && !paymentByBill.has(b.id),
  ).length;

  const collectionDataQuality: string[] = [];
  if (paidBillsWithoutLedger > 0) {
    collectionDataQuality.push(
      `${paidBillsWithoutLedger} فاتورة معلّمة كمدفوعة بلا سجل دفع معتمد؛ لم تُحتسب كتحصيل نقدي.`,
    );
  }
  if (orphanPayments > 0) {
    collectionDataQuality.push(
      `${orphanPayments} دفعة معتمدة لا ترتبط بفاتورة مؤهلة ضمن نافذة الـ30 يوماً؛ لم تُحتسب.`,
    );
  }
  if (invalidPayments > 0) {
    collectionDataQuality.push(
      `${invalidPayments} دفعة معتمدة بقيمة غير صالحة؛ لم تُحتسب.`,
    );
  }
  if (collectedTotal > billedTotal && billedTotal > 0) {
    collectionDataQuality.push(
      "التحصيل الفعلي أكبر من المبلغ المفوتر المؤهل في النافذة؛ عُرضت النسبة دون سقف وقد يدل ذلك على فروقات توقيت أو ربط.",
    );
  }

  const consumptionByDay = new Map<string, number>();
  validApproved.forEach((r) => {
    const day = r.created_at.slice(0, 10);
    consumptionByDay.set(
      day,
      (consumptionByDay.get(day) ?? 0) + Number(r.consumption),
    );
  });

  const billedByDay = new Map<string, number>();
  eligibleBills.forEach((b) => {
    const day = b.issued_at.slice(0, 10);
    billedByDay.set(day, (billedByDay.get(day) ?? 0) + Number(b.total));
  });

  const collectedByDay = new Map<string, number>();
  validApprovedPayments.forEach((p) => {
    const day = p.created_at.slice(0, 10);
    collectedByDay.set(day, (collectedByDay.get(day) ?? 0) + Number(p.amount));
  });

  const days = new Set([
    ...consumptionByDay.keys(),
    ...billedByDay.keys(),
    ...collectedByDay.keys(),
  ]);

  return {
    tenantId,
    customersTotal: customers.data?.length ?? 0,
    customersActive: customers.data?.filter((c) => c.status === "active").length ?? 0,
    readingsTotal: readingRows.length,
    approvedReadings: approved.length,
    pendingReadings: readingRows.filter((r) => r.status === "pending").length,
    rejectedReadings: readingRows.filter((r) => r.status === "rejected").length,
    approvedConsumption: validApproved.reduce(
      (sum, r) => sum + Number(r.consumption),
      0,
    ),
    operationalEfficiency:
      readingRows.length > 0 ? (approved.length / readingRows.length) * 100 : null,
    billedTotal,
    collectedTotal,
    eligibleBills: eligibleBills.length,
    approvedPayments: validApprovedPayments.length,
    paidBillsWithoutLedger,
    invalidReadings: invalidReadings.length,
    inconsistentReadings: inconsistentReadings.length,
    orphanPayments,
    invalidPayments,
    collectionDataQuality,
    consumptionTrend: [...days]
      .sort()
      .map((day) => ({ day, consumption: consumptionByDay.get(day) ?? 0 })),
    financeTrend: [...days]
      .sort()
      .map((day) => ({
        day,
        billed: billedByDay.get(day) ?? 0,
        collected: collectedByDay.get(day) ?? 0,
      })),
    flagBreakdown: [...new Set(
      readingRows.filter((r) => r.flag && r.flag !== "ok").map((r) => r.flag),
    )].map((name) => ({
      name,
      value: readingRows.filter((r) => r.flag === name).length,
    })),
    fetchedAt: new Date().toISOString(),
  };
}

function Dashboard() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["dashboard"],
    queryFn: loadDashboard,
    staleTime: 15000,
  });
  const tenantId = data?.tenantId ?? null;
  const [live, setLive] = useState<"connecting" | "live" | "off">("connecting");

  useEffect(() => {
    if (!tenantId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["dashboard"] });
      }, 600);
    };
    const channel = supabase.channel(`dashboard:${tenantId}`);
    (["water_readings", "water_bills", "payments", "customers"] as const).forEach(
      (table) => {
        channel.on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table,
            filter: `tenant_id=eq.${tenantId}`,
          },
          refresh,
        );
      },
    );
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") setLive("live");
      if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        setLive("off");
      }
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
        <CardHeader><CardTitle>تعذر تحميل بيانات اللوحة</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>{(error as Error)?.message ?? "خطأ غير معروف"}</p>
          <Button onClick={() => void refetch()} size="sm">إعادة المحاولة</Button>
        </CardContent>
      </Card>
    );
  }

  if (!data.tenantId) {
    return (
      <Card dir="rtl">
        <CardHeader><CardTitle>غير متاح — لا يوجد مشروع مرتبط بحسابك</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          لا يمكن عرض مؤشرات مشروع قبل ربط جلسة الحساب بمشروع مياه.
        </CardContent>
      </Card>
    );
  }

  const alerts =
    data.invalidReadings +
    data.inconsistentReadings +
    data.paidBillsWithoutLedger +
    data.orphanPayments +
    data.invalidPayments;

  return (
    <TooltipProvider>
      <div className="space-y-6" dir="rtl">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">لوحة التحكم</h1>
            <p className="text-sm text-muted-foreground mt-1">
              المشروع الحالي فقط · نافذة آخر {WINDOW_DAYS} يوماً · المصدر: قاعدة البيانات
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
              disabled={isFetching}
              aria-label="تحديث البيانات"
            >
              <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi
            title="كفاءة استخدام المياه"
            value="غير متاح"
            icon={<Droplets className="w-5 h-5" />}
            sub="لا توجد كمية إنتاج/ضخ موثقة في مخطط البيانات الحالي."
            how="المعادلة المطلوبة: الاستهلاك المعتمد ÷ مياه النظام الداخلة/الإنتاج × 100. لا تُحسب دون مصدر إنتاج موثوق للفترة نفسها."
          />
          <Kpi
            title="فاقد المياه NRW"
            value="غير متاح"
            icon={<TrendingUp className="w-5 h-5" />}
            sub="لا توجد كمية إنتاج/ضخ موثقة في مخطط البيانات الحالي."
            how="المعادلة: (مياه النظام الداخلة − الاستهلاك المصرح المقاس) ÷ مياه النظام الداخلة × 100. لا توجد بيانات إنتاج/ضخ موثقة لحسابها."
          />
          <Kpi
            title="معدل التحصيل الفعلي"
            value={collection === null ? "غير متاح" : `${collection.toFixed(1)}%`}
            icon={<Percent className="w-5 h-5" />}
            sub={
              collection === null
                ? "لا يوجد مبلغ مفوتر مؤهل في آخر 30 يوماً."
                : `المحصّل ${fmtYER(data.collectedTotal)} من ${fmtYER(data.billedTotal)}`
            }
            how="المعادلة: مجموع payments المعتمدة المرتبطة بفواتير مؤهلة ÷ مجموع الفواتير المؤهلة ذات reading_id وقيمة صحيحة، في نفس نافذة 30 يوماً × 100. water_bills.status لا يُستخدم كدليل على النقد المحصل. لا يوجد سقف اصطناعي للنسبة."
          />
          <Kpi
            title="الكفاءة التشغيلية"
            value={
              data.operationalEfficiency === null
                ? "غير متاح"
                : `${data.operationalEfficiency.toFixed(1)}%`
            }
            icon={<Users className="w-5 h-5" />}
            sub={`${fmtNum(data.approvedReadings)} معتمدة من ${fmtNum(data.readingsTotal)} قراءة`}
            how="المعادلة: عدد القراءات المعتمدة ÷ إجمالي القراءات المسجلة في آخر 30 يوماً × 100. المقام يشمل pending وrejected."
          />
        </div>

        <div className="grid lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>اتجاه الاستهلاك المعتمد</CardTitle>
              <How text="قراءات status='approved' وقيم consumption غير سالبة وصحيحة، مجمعة يومياً حسب created_at." />
            </CardHeader>
            <CardContent className="h-72">
              {data.consumptionTrend.length === 0 ? (
                <Empty text="لا توجد قراءات معتمدة كافية في النافذة الزمنية." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.consumptionTrend}>
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
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>التحصيل الفعلي</CardTitle>
              <How text="المبلغ المفوتر المؤهل مقابل المدفوعات المعتمدة المرتبطة به، وكلاهما ضمن نافذة 30 يوماً." />
            </CardHeader>
            <CardContent className="h-72">
              {data.financeTrend.length === 0 ? (
                <Empty />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.financeTrend}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                    <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: number) => fmtYER(v)} />
                    <Legend />
                    <Line type="monotone" dataKey="billed" name="مفوتر" stroke="var(--muted-foreground)" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="collected" name="محصل فعلياً" stroke="var(--water)" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid lg:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>سير العمل</CardTitle>
              <How text="الأعداد الفعلية في نافذة 30 يوماً: قراءات، قراءات معتمدة، فواتير مؤهلة، ومدفوعات معتمدة." />
            </CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={[
                    { name: "قراءات", value: data.readingsTotal },
                    { name: "معتمدة", value: data.approvedReadings },
                    { name: "فواتير", value: data.eligibleBills },
                    { name: "مدفوعات", value: data.approvedPayments },
                  ]}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="value" name="عدد" fill="var(--water)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>جودة البيانات والتنبيهات</CardTitle>
              <Badge variant={alerts > 0 ? "destructive" : "secondary"}>{alerts}</Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.invalidReadings > 0 && (
                <Alert text={`${data.invalidReadings} قراءة معتمدة بقيمة استهلاك غير صالحة؛ استُبعدت من الاستهلاك.`} />
              )}
              {data.inconsistentReadings > 0 && (
                <Alert text={`${data.inconsistentReadings} قراءة فيها current_reading أقل من previous؛ تحتاج مراجعة.`} />
              )}
              {data.collectionDataQuality.map((text) => (
                <Alert key={text} text={text} />
              ))}
              {alerts === 0 && (
                <p className="text-sm text-muted-foreground">
                  لا توجد تنبيهات جودة بيانات مؤكدة ضمن نافذة الـ30 يوماً.
                </p>
              )}
              <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <span>معلّقة: {fmtNum(data.pendingReadings)}</span>
                <span>مرفوضة: {fmtNum(data.rejectedReadings)}</span>
                <span>دفعات معتمدة: {fmtNum(data.approvedPayments)}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {data.flagBreakdown.length > 0 && (
          <Card>
            <CardHeader><CardTitle>تصنيف القراءات الشاذة</CardTitle></CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.flagBreakdown}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="value" name="عدد" fill="var(--destructive)" radius={[4, 4, 4, 4]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle>بيانات المؤشرات غير المتاحة</CardTitle></CardHeader>
          <CardContent className="grid md:grid-cols-2 gap-3 text-sm">
            <DataUnavailable
              title="كفاءة استخدام المياه"
              reason="يلزم مصدر موثوق لكمية الإنتاج/الضخ لنفس المشروع والفترة."
            />
            <DataUnavailable
              title="NRW"
              reason="يلزم مصدر موثوق لمياه النظام الداخلة/الإنتاج. لم يتم إنشاء أو اختلاق بيانات بديلة."
            />
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}

function How({ text }: { text: string }) {
  return (
    <UITooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label="كيف حُسب؟" className="text-muted-foreground hover:text-foreground">
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

function Alert({ text }: { text: string }) {
  return (
    <div className="flex gap-2 items-start rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />
      <span>{text}</span>
    </div>
  );
}

function DataUnavailable({ title, reason }: { title: string; reason: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <div className="font-semibold">{title}: غير متاح</div>
      <div className="text-muted-foreground mt-1">{reason}</div>
    </div>
  );
}

function Kpi({
  title,
  value,
  icon,
  sub,
  how,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  sub?: string;
  how: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="truncate">{title}</span>
              <How text={how} />
            </div>
            <div className="mt-2 text-xl md:text-2xl font-bold">{value}</div>
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
