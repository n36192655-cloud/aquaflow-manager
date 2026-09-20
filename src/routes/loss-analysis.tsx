import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { AlertTriangle, Droplets, RefreshCw, TrendingDown } from "lucide-react";
import { fmtNum } from "@/lib/pricing";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";

export const Route = createFileRoute("/loss-analysis")({
  head: () => ({ meta: [{ title: "تحليل فاقد المياه — ميزان" }] }),
  component: LossAnalysisPage,
});

const LOSS_THRESHOLD = 15;

type ProductionLog = {
  id: string;
  recorded_at: string;
  source_name: string;
  production_m3: number | string | null;
  note: string | null;
  capture_source: string;
  created_by: string | null;
  verification_status: "pending" | "approved" | "rejected";
};

type Reading = {
  id: string;
  consumption: number | null;
  created_at: string;
  verification_status: "pending" | "approved" | "rejected";
  status: string;
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function monthAgoISO() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}

function endExclusiveISO(date: string) {
  const start = new Date(`${date}T00:00:00`);
  if (Number.isNaN(start.getTime())) return new Date().toISOString();
  return new Date(start.getTime() + 86400000).toISOString();
}

function LossAnalysisPage() {
  const { user } = useAuth();
  const [productionLogs, setProductionLogs] = useState<ProductionLog[]>([]);
  const [units, setUnits] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [note, setNote] = useState("");
  const [from, setFrom] = useState(monthAgoISO());
  const [to, setTo] = useState(todayISO());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consumed, setConsumed] = useState(0);
  const [readingCount, setReadingCount] = useState(0);

  const loadData = useCallback(async () => {
    if (!user?.tenantId || user.isSuperAdmin) {
      setProductionLogs([]);
      setConsumed(0);
      setReadingCount(0);
      setLoading(false);
      return;
    }

    if (from > to) {
      setError("تاريخ البداية يجب أن يكون قبل أو يساوي تاريخ النهاية.");
      setProductionLogs([]);
      setConsumed(0);
      setReadingCount(0);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const start = new Date(`${from}T00:00:00`).toISOString();
    const end = endExclusiveISO(to);

    const [productionResult, readingsResult] = await Promise.all([
      supabase
        .from("water_production_logs")
        .select(
          "id,recorded_at,source_name,production_m3,note,capture_source,created_by,verification_status",
        )
        .eq("tenant_id", user.tenantId)
        .gte("recorded_at", start)
        .lt("recorded_at", end)
        .order("recorded_at", { ascending: false }),
      supabase
        .from("water_readings")
        .select("id,consumption,created_at,verification_status,status")
        .eq("tenant_id", user.tenantId)
        .eq("verification_status", "approved")
        .eq("status", "approved")
        .gte("created_at", start)
        .lt("created_at", end),
    ]);

    if (productionResult.error || readingsResult.error) {
      console.error(productionResult.error ?? readingsResult.error);
      setError("تعذر تحميل بيانات فاقد المياه من قاعدة البيانات.");
      setProductionLogs([]);
      setConsumed(0);
      setReadingCount(0);
      setLoading(false);
      return;
    }

    setProductionLogs((productionResult.data ?? []) as ProductionLog[]);
    const validReadings = ((readingsResult.data ?? []) as Reading[]).filter(
      (r) => Number.isFinite(Number(r.consumption)) && Number(r.consumption) >= 0,
    );
    setConsumed(validReadings.reduce((sum, r) => sum + Number(r.consumption), 0));
    setReadingCount(validReadings.length);
    setLoading(false);
  }, [user?.tenantId, user?.isSuperAdmin, from, to]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function submit() {
    if (!user?.tenantId || user.isSuperAdmin) {
      toast.error("لا يوجد مشروع تشغيلي مرتبط بالحساب");
      return;
    }

    const n = Number(units);
    const source = sourceName.trim();
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("أدخل قيمة إنتاج صحيحة أكبر من صفر");
      return;
    }
    if (n > 100000000) {
      toast.error("قيمة الإنتاج تتجاوز الحد التشغيلي المسموح");
      return;
    }
    if (!source) {
      toast.error("أدخل مصدر قياس الإنتاج");
      return;
    }

    setSaving(true);
    const clientId = crypto.randomUUID();
    const { error: rpcError } = await supabase.rpc("record_water_production", {
      p_source_name: source,
      p_production_m3: n,
      p_capture_source: "field_manual",
      p_note: note.trim() || null,
      p_recorded_at: new Date().toISOString(),
      p_client_id: clientId,
    });
    setSaving(false);

    if (rpcError) {
      console.error(rpcError);
      toast.error("تعذر حفظ سجل الإنتاج");
      return;
    }

    setUnits("");
    setSourceName("");
    setNote("");
    toast.success("تم تسجيل الإنتاج وإرساله للمراجعة");
    await loadData();
  }

  const analytics = useMemo(() => {
    const produced = productionLogs
      .filter((p) => p.verification_status === "approved")
      .map((p) => Number(p.production_m3))
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((sum, value) => sum + value, 0);
    const loss = Math.max(0, produced - consumed);
    const pct = produced > 0 ? (loss / produced) * 100 : 0;
    return { produced, loss, pct };
  }, [productionLogs, consumed]);

  const chartData = [
    {
      name: "المياه (م³)",
      produced: analytics.produced,
      consumed,
      loss: analytics.loss,
    },
  ];

  if (!user?.tenantId || user.isSuperAdmin) {
    return (
      <div dir="rtl">
        <Card>
          <CardContent className="p-8 text-center">
            <h1 className="font-bold">لا يوجد مشروع تشغيلي مرتبط بالحساب</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              لا يتم عرض بيانات اصطناعية أو بيانات مشروع آخر.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div dir="rtl" className="space-y-6 pb-8">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <Badge variant="outline" className="mb-2">
            بيانات قاعدة البيانات
          </Badge>
          <h1 className="text-2xl md:text-3xl font-bold">تحليل فاقد المياه والتسرب</h1>
          <p className="text-sm text-muted-foreground mt-1">
            الفرق بين مدخل المياه المعتمد والاستهلاك المعتمد للمشروع الحالي.
          </p>
        </div>
        <Button variant="outline" onClick={() => void loadData()} disabled={loading || saving}>
          <RefreshCw className={`h-4 w-4 ms-1 ${loading ? "animate-spin" : ""}`} /> تحديث
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">تسجيل مدخل مياه جديد</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>مصدر القياس</Label>
              <Input
                value={sourceName}
                onChange={(e) => setSourceName(e.target.value)}
                placeholder="مثال: عداد الإنتاج الرئيسي"
                disabled={saving}
              />
            </div>
            <div>
              <Label>حجم الإنتاج/الضخ (م³)</Label>
              <Input
                type="number"
                min="0"
                step="0.001"
                value={units}
                onChange={(e) => setUnits(e.target.value)}
                placeholder="مثال: 12500"
                disabled={saving}
              />
            </div>
            <div>
              <Label>ملاحظة</Label>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="مصدر القياس أو ملاحظة التشغيل"
                disabled={saving}
              />
            </div>
            <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              لا يتم تخزين صورة أو Data URL لأن جدول سجلات الإنتاج الحالي لا يحتوي حقلاً للصورة.
            </div>
            <Button onClick={() => void submit()} className="w-full" disabled={saving}>
              <Droplets className="w-4 h-4 ms-1" /> {saving ? "جارٍ الحفظ…" : "حفظ وإرسال للمراجعة"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">فلترة الفترة</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>من تاريخ</Label>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <Label>إلى تاريخ</Label>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
            <div className="pt-2">
              <LossStat
                label="فاقد المياه"
                pct={analytics.pct}
                loss={analytics.loss}
                unit="م³"
                icon={<Droplets className="w-4 h-4" />}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
              <div>
                مدخل معتمد:{" "}
                <span className="font-semibold text-foreground">
                  {fmtNum(analytics.produced)} م³
                </span>
              </div>
              <div>
                استهلاك معتمد:{" "}
                <span className="font-semibold text-foreground">{fmtNum(consumed)} م³</span>
              </div>
              <div>
                القراءات المعتمدة:{" "}
                <span className="font-semibold text-foreground">{readingCount}</span>
              </div>
              <div>
                السجلات المعتمدة:{" "}
                <span className="font-semibold text-foreground">
                  {productionLogs.filter((p) => p.verification_status === "approved").length}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">مدخل المياه مقابل الاستهلاك والفاقد</CardTitle>
        </CardHeader>
        <CardContent className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => fmtNum(v)} />
              <Legend />
              <Bar dataKey="produced" name="مدخل معتمد" fill="var(--water)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="consumed" name="استهلاك معتمد" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
              <Bar dataKey="loss" name="فاقد حسابي" fill="#dc2626" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {analytics.produced > 0 && analytics.pct > LOSS_THRESHOLD && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-destructive mt-0.5" />
            <div className="text-sm">
              <div className="font-semibold">تنبيه — نسبة الفاقد تتجاوز العتبة التشغيلية</div>
              <div className="text-muted-foreground mt-1">
                الفاقد الحسابي {analytics.pct.toFixed(1)}%. يجب تفسيره ميدانياً قبل اعتباره تسرباً
                أو فقداً فنياً.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">سجلات مدخل المياه</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-6">جارٍ تحميل البيانات…</p>
          ) : productionLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              لا توجد سجلات إنتاج في الفترة المحددة.
            </p>
          ) : (
            productionLogs.map((p) => (
                  </div>
                  <Button size="icon" variant="ghost" onClick={() => deleteProductionLog(p.id)}>
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LossStat({
  label,
  pct,
  loss,
  unit,
  icon,
}: {
  label: string;
  pct: number;
  loss: number;
  unit: string;
  icon: React.ReactNode;
}) {
  const danger = pct > LOSS_THRESHOLD;
  return (
    <div
      className={`p-3 rounded-lg border ${danger ? "border-destructive/40 bg-destructive/5" : "bg-muted/30"}`}
    >
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className={`text-xl font-bold mt-1 ${danger ? "text-destructive" : ""}`}>
        {pct.toFixed(1)}%
      </div>
      <div className="text-[11px] text-muted-foreground">
        {fmtNum(loss)} {unit}
      </div>
    </div>
  );
}
