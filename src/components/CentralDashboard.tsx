import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Droplets, RefreshCw, Wallet, Waves } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";

type ProjectMetric = {
  tenant_id: string;
  project_name: string;
  subscription_status: string;
  active_customers: number;
  total_readings: number;
  approved_readings: number;
  pending_readings: number;
  rejected_readings: number;
  approved_consumption_m3: number;
  production_input_m3: number | null;
  water_efficiency_pct: number | null;
  metered_balance_gap_pct: number | null;
  billed_amount: number;
  collected_amount: number;
  collection_rate_pct: number | null;
};

const pct = (v: number | null) => v == null ? "غير متاح" : `${Number(v).toFixed(1)}%`;
const money = (v: number) => new Intl.NumberFormat("ar-YE", { maximumFractionDigits: 0 }).format(Number(v) || 0);

export function CentralDashboard() {
  const [projects, setProjects] = useState<ProjectMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setError(null);
      const { data, error } = await supabase.rpc("central_dashboard_project_metrics", { p_days: 30 });
      if (error) throw error;
      setProjects((data ?? []) as ProjectMetric[]);
    } catch (e) {
      console.error("[Mizan] central dashboard load failed", e);
      setError("تعذر تحميل مؤشرات المشاريع التابعة من قاعدة البيانات.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const summary = useMemo(() => ({
    customers: projects.reduce((s, p) => s + Number(p.active_customers || 0), 0),
    consumption: projects.reduce((s, p) => s + Number(p.approved_consumption_m3 || 0), 0),
    production: projects.reduce((s, p) => s + Number(p.production_input_m3 || 0), 0),
    billed: projects.reduce((s, p) => s + Number(p.billed_amount || 0), 0),
    collected: projects.reduce((s, p) => s + Number(p.collected_amount || 0), 0),
    pending: projects.reduce((s, p) => s + Number(p.pending_readings || 0), 0),
  }), [projects]);

  const efficiency = summary.production > 0 ? summary.consumption / summary.production * 100 : null;
  const collection = summary.billed > 0 ? summary.collected / summary.billed * 100 : null;

  return <div dir="rtl" className="space-y-6 pb-8">
    <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div>
        <Badge variant="outline" className="mb-2">المستأجر المركزي</Badge>
        <h1 className="text-2xl md:text-3xl font-bold">لوحة الإشراف على المشاريع</h1>
        <p className="mt-1 text-sm text-muted-foreground">مؤشرات موحّدة لآخر 30 يوماً لجميع المشاريع المرتبطة بالمستأجر المركزي.</p>
      </div>
      <Button variant="outline" onClick={() => void refresh()} disabled={refreshing}>
        <RefreshCw className={`h-4 w-4 ms-1 ${refreshing ? "animate-spin" : ""}`} /> تحديث
      </Button>
    </header>

    {error && <div className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{error}</div>}

    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <SummaryCard title="المشاريع التابعة" value={projects.length} icon={<Waves className="h-5 w-5" />} />
      <SummaryCard title="المشتركون النشطون" value={summary.customers} icon={<Droplets className="h-5 w-5" />} />
      <SummaryCard title="كفاءة المياه المجمعة" value={pct(efficiency)} icon={<CheckCircle2 className="h-5 w-5" />} />
      <SummaryCard title="نسبة التحصيل المجمعة" value={pct(collection)} icon={<Wallet className="h-5 w-5" />} />
    </div>

    <Card>
      <CardHeader><CardTitle>ملخص المشاريع</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-sm">
          <thead><tr className="border-b text-right text-muted-foreground">
            <th className="p-3">المشروع</th><th className="p-3">الحالة</th><th className="p-3">المشتركون</th>
            <th className="p-3">الاستهلاك م³</th><th className="p-3">الإنتاج م³</th><th className="p-3">الكفاءة</th>
            <th className="p-3">التحصيل</th><th className="p-3">قراءات معلقة</th>
          </tr></thead>
          <tbody>{projects.map((p) => <tr key={p.tenant_id} className="border-b last:border-0">
            <td className="p-3 font-medium">{p.project_name}</td>
            <td className="p-3"><Badge variant={p.subscription_status === "active" ? "default" : "destructive"}>{p.subscription_status === "active" ? "نشط" : p.subscription_status === "suspended" ? "موقوف" : "منتهي"}</Badge></td>
            <td className="p-3">{p.active_customers}</td>
            <td className="p-3">{Number(p.approved_consumption_m3).toFixed(2)}</td>
            <td className="p-3">{p.production_input_m3 == null ? "غير متاح" : Number(p.production_input_m3).toFixed(2)}</td>
            <td className="p-3">{pct(p.water_efficiency_pct)}</td>
            <td className="p-3">{pct(p.collection_rate_pct)} <span className="text-xs text-muted-foreground">({money(p.collected_amount)})</span></td>
            <td className="p-3">{p.pending_readings}</td>
          </tr>)}</tbody>
        </table>
        {!projects.length && !loading && <div className="py-8 text-center text-sm text-muted-foreground">لا توجد مشاريع تابعة مرتبطة بالمستأجر المركزي.</div>}
      </CardContent>
    </Card>

    <div className="grid gap-4 md:grid-cols-3">
      <Card><CardContent className="p-5"><div className="text-xs text-muted-foreground">إجمالي الإنتاج المعتمد</div><div className="mt-2 text-2xl font-bold">{summary.production.toFixed(2)} م³</div></CardContent></Card>
      <Card><CardContent className="p-5"><div className="text-xs text-muted-foreground">إجمالي الاستهلاك المعتمد</div><div className="mt-2 text-2xl font-bold">{summary.consumption.toFixed(2)} م³</div></CardContent></Card>
      <Card><CardContent className="p-5"><div className="text-xs text-muted-foreground">الفواتير / المحصل</div><div className="mt-2 text-2xl font-bold">{money(summary.billed)} / {money(summary.collected)}</div></CardContent></Card>
    </div>

    {summary.pending > 0 && <div className="flex items-center gap-2 rounded-lg border p-3 text-sm"><AlertTriangle className="h-4 w-4 shrink-0" /> توجد {summary.pending} قراءة معلقة عبر المشاريع وتحتاج مراجعة مديري المشاريع.</div>}
    {loading && <p className="text-center text-xs text-muted-foreground">جارٍ تحميل المؤشرات المركزية…</p>}
    <p className="text-xs leading-5 text-muted-foreground">هذه اللوحة تقرأ المؤشرات المجمعة من Supabase مباشرة. لا تستخدم بيانات Zustand أو localStorage كمصدر حقيقة، ولا تمنح المستأجر المركزي صلاحية تعديل بيانات المشاريع من خلال هذه اللوحة.</p>
  </div>;
}

function SummaryCard({ title, value, icon }: { title: string; value: string | number; icon: React.ReactNode }) {
  return <Card><CardContent className="p-5"><div className="h-10 w-10 rounded-xl bg-muted grid place-items-center">{icon}</div><div className="mt-4 text-xs text-muted-foreground">{title}</div><div className="mt-1 text-2xl font-bold">{value}</div></CardContent></Card>;
}
