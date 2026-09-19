import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Save, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/tariffs")({
  head: () => ({ meta: [{ title: "التعرفة الشرائحية — ميزان" }] }),
  component: TariffsPage,
});

type Plan = { id: string; name: string; currency_code: string; benchmark_lpd: number; basic_lpd: number; optimal_lpd: number; active: boolean };
type Tier = { id: string; plan_id: string; label: string; min_lpd: number; max_lpd: number | null; rate_per_m3: number; sort_order: number };

function TariffsPage() {
  const { user } = useAuth();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!user?.tenantId) return;
    const [p, t] = await Promise.all([
      supabase.from("water_tariff_plans").select("id,name,currency_code,benchmark_lpd,basic_lpd,optimal_lpd,active").eq("tenant_id", user.tenantId).eq("active", true).order("effective_from", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("water_tariff_tiers").select("id,plan_id,label,min_lpd,max_lpd,rate_per_m3,sort_order").order("sort_order"),
    ]);
    if (p.error) throw p.error;
    if (t.error) throw t.error;
    setPlan((p.data ?? null) as Plan | null);
    setTiers(((t.data ?? []) as Tier[]).filter((x) => !p.data || x.plan_id === p.data.id));
  }

  useEffect(() => { void load().catch(() => toast.error("تعذر تحميل إعدادات التعرفة")); }, [user?.tenantId]);

  async function save() {
    if (!plan || !user?.tenantId) return;
    if (!Number.isFinite(Number(plan.basic_lpd)) || !Number.isFinite(Number(plan.benchmark_lpd)) || !Number.isFinite(Number(plan.optimal_lpd)) || Number(plan.basic_lpd) <= 0 || Number(plan.basic_lpd) > Number(plan.benchmark_lpd) || Number(plan.benchmark_lpd) > Number(plan.optimal_lpd)) {
      return toast.error("مراجع الاستهلاك غير مرتبة بشكل صحيح");
    }
    if (tiers.some((t) => !Number.isFinite(Number(t.rate_per_m3)) || Number(t.rate_per_m3) < 0)) return toast.error("يوجد سعر تعرفة غير صالح");
    setBusy(true);
    try {
      const { error } = await supabase.from("water_tariff_plans").update({
        basic_lpd: Number(plan.basic_lpd),
        benchmark_lpd: Number(plan.benchmark_lpd),
        optimal_lpd: Number(plan.optimal_lpd),
      }).eq("id", plan.id).eq("tenant_id", user.tenantId);
      if (error) throw error;
      for (const tier of tiers) {
        const result = await supabase.from("water_tariff_tiers").update({ rate_per_m3: Number(tier.rate_per_m3) }).eq("id", tier.id).eq("plan_id", plan.id);
        if (result.error) throw result.error;
      }
      toast.success("تم حفظ التعرفة؛ الحساب الفعلي للفواتير يتم داخل قاعدة البيانات");
      await load();
    } catch (e) {
      toast.error("تعذر حفظ التعرفة");
    } finally { setBusy(false); }
  }

  if (!plan) return <div dir="rtl"><Card><CardContent className="p-8 text-center"><h1 className="font-bold">لا توجد تعرفة نشطة</h1><p className="mt-2 text-sm text-muted-foreground">يجب إنشاء تعرفة للمشروع قبل إصدار فواتير جديدة.</p><Button className="mt-4" variant="outline" onClick={() => void load()}><RefreshCw className="w-4 h-4 ms-1"/> تحديث</Button></CardContent></Card></div>;

  return <div dir="rtl" className="space-y-6">
    <div><h1 className="text-2xl md:text-3xl font-bold">التعرفة الشرائحية</h1><p className="mt-1 text-sm text-muted-foreground">إعداد المشروع للتعرفة والاستهلاك للفرد. القيم الظاهرة قابلة للإدارة، لكن الفاتورة لا تعتمد على واجهة المستخدم.</p></div>
    <Card><CardHeader><CardTitle>مراجع استهلاك الأسرة</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-3">
      <div><Label>الحد الأساسي المرجعي (لتر/فرد/يوم)</Label><Input type="number" min="1" value={plan.basic_lpd} onChange={e=>setPlan({...plan,basic_lpd:Number(e.target.value)})}/></div>
      <div><Label>المعيار التشغيلي (لتر/فرد/يوم)</Label><Input type="number" min="1" value={plan.benchmark_lpd} onChange={e=>setPlan({...plan,benchmark_lpd:Number(e.target.value)})}/></div>
      <div><Label>المستوى الأمثل المرجعي</Label><Input type="number" min="1" value={plan.optimal_lpd} onChange={e=>setPlan({...plan,optimal_lpd:Number(e.target.value)})}/></div>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>الشرائح السعرية</CardTitle></CardHeader><CardContent className="space-y-3">{tiers.sort((a,b)=>a.sort_order-b.sort_order).map(t=><div key={t.id} className="grid grid-cols-[1fr_140px] gap-3 items-end rounded-lg border p-3"><div><b>{t.label}</b><div className="text-xs text-muted-foreground">{t.min_lpd} إلى {t.max_lpd ?? "أكثر"} لتر/فرد/يوم · السعر لكل م³</div></div><div><Label>السعر</Label><Input type="number" min="0" step="0.001" value={t.rate_per_m3} onChange={e=>setTiers(ts=>ts.map(x=>x.id===t.id?{...x,rate_per_m3:Number(e.target.value)}:x))}/></div></div>)}</CardContent></Card>
    <div className="flex justify-end"><Button onClick={()=>void save()} disabled={busy}><Save className="w-4 h-4 ms-1"/>{busy?"جاري الحفظ...":"حفظ التعرفة"}</Button></div>
    <div className="rounded-lg border bg-muted/30 p-4 text-xs leading-6">
      <b>مهم:</b> منظمة الصحة العالمية تعرض 20 لتر/فرد/يوم تقريباً كمستوى أساسي، ونحو 50 للمستوى المتوسط، و100+ للمستوى الأمثل. هذه مؤشرات مرتبطة بمستوى الخدمة والصحة وليست «تعرفة إلزامية» أو حداً قانونياً للاستهلاك. ميزان يستخدمها كمرجع قابل للتهيئة، بينما الجهة المالكة للمشروع تحدد الأسعار الفعلية.
    </div>
  </div>;
}
