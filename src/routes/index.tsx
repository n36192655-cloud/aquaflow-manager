import { createFileRoute } from "@tanstack/react-router";
import { useStore } from "@/lib/store";
import { fmtYER, fmtNum } from "@/lib/pricing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Droplets, Users, AlertTriangle, Receipt, TrendingUp, Camera, CheckCircle2, WifiOff, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useOnlineStatus, usePendingCount } from "@/lib/sync";

export const Route = createFileRoute("/")({ component: Dashboard });

function Dashboard() {
  const { customers, meters, readings, bills, payments } = useStore();
  const online = useOnlineStatus();
  const pendingOffline = usePendingCount();
  const activeCustomers = customers.filter((c) => c.status !== "rejected");
  const activeMeters = meters.filter((m) => m.status === "active");
  const approvedReadings = readings.filter((r) => r.status === "approved");
  const pendingReadings = readings.filter((r) => r.status === "pending");
  const rejectedReadings = readings.filter((r) => r.status === "rejected");
  const paid = bills.filter((b) => b.status === "paid");
  const openBills = bills.filter((b) => b.status !== "paid");
  const outstanding = openBills.reduce((sum, b) => sum + Math.max(0, b.total - payments.filter((p) => p.bill_id === b.id && p.status === "approved").reduce((a, p) => a + p.amount, 0)), 0);
  const collections = payments.filter((p) => p.status === "approved").reduce((a, p) => a + p.amount, 0);
  const consumption = approvedReadings.reduce((a, r) => a + Math.max(0, r.consumption), 0);
  const readingCoverage = activeMeters.length ? Math.round((new Set(approvedReadings.map((r) => r.meter_id)).size / activeMeters.length) * 100) : 0;
  const identityChecked = readings.filter((r) => r.ocr_serial).length;
  const suspicious = readings.filter((r) => r.flag !== "ok");

  return <div className="space-y-6">
    <div className="flex items-start justify-between gap-3"><div><h1 className="text-2xl md:text-3xl font-bold">لوحة التحكم</h1><p className="text-sm text-muted-foreground mt-1">منصة ميزان لإستدامة خدمات المياه — مشروع مياه المسراخ</p></div><Badge variant={online ? "outline" : "destructive"}>{online ? "متصل" : "أوفلاين"}</Badge></div>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4"><StatCard title="المشتركون النشطون" value={fmtNum(activeCustomers.length)} icon={<Users className="w-5 h-5" />} /><StatCard title="العدادات النشطة" value={fmtNum(activeMeters.length)} icon={<Droplets className="w-5 h-5" />} /><StatCard title="تغطية القراءات" value={`${readingCoverage}%`} icon={<Camera className="w-5 h-5" />} /><StatCard title="الاستهلاك المعتمد" value={`${fmtNum(consumption)} م³`} icon={<Droplets className="w-5 h-5" />} /></div>
    <Card><CardHeader><CardTitle>سلسلة التشغيل</CardTitle></CardHeader><CardContent className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3"><Process label="صور/قراءات" value={readings.length} icon={<Camera />} /><Process label="تحقق هوية" value={identityChecked} icon={<CheckCircle2 />} /><Process label="مقبولة" value={approvedReadings.length} icon={<CheckCircle2 />} /><Process label="معلقة" value={pendingReadings.length} icon={<Clock3 />} /><Process label="مرفوضة" value={rejectedReadings.length} icon={<AlertTriangle />} /><Process label="فواتير" value={bills.length} icon={<Receipt />} /><Process label="مدفوعة" value={paid.length} icon={<CheckCircle2 />} /><Process label="مزامنة معلقة" value={pendingOffline} icon={<WifiOff />} /></CardContent></Card>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4"><StatCard title="التحصيل المعتمد" value={fmtYER(collections)} icon={<TrendingUp className="w-5 h-5" />} /><StatCard title="الرصيد المستحق" value={fmtYER(outstanding)} icon={<Receipt className="w-5 h-5" />} /><StatCard title="قراءات مشبوهة/خاطئة" value={fmtNum(suspicious.length)} icon={<AlertTriangle className="w-5 h-5" />} /><StatCard title="فواتير غير مسددة" value={fmtNum(openBills.length)} icon={<Receipt className="w-5 h-5" />} /></div>
    <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle>سلامة القراءة</CardTitle><Badge variant={suspicious.length ? "destructive" : "outline"}>{suspicious.length ? "تحتاج مراجعة" : "لا توجد تنبيهات"}</Badge></CardHeader><CardContent className="space-y-3 text-sm"><div className="flex justify-between"><span>قراءات بانتظار الاعتماد</span><strong>{pendingReadings.length}</strong></div><div className="flex justify-between"><span>قراءات مرتبطة بنتيجة OCR</span><strong>{identityChecked}</strong></div><div className="flex justify-between"><span>الفواتير ذات رصيد مستحق</span><strong>{openBills.length}</strong></div><p className="text-xs text-muted-foreground">لا تعتبر نتيجة OCR أو لون أرقام العداد إثباتًا نهائيًا للدقة العشرية؛ القراءة المعتمدة يجب أن تطابق ملف العداد ومراجعة المشغّل عند انخفاض الثقة.</p></CardContent></Card>
  </div>;
}
function StatCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) { return <Card><CardContent className="p-5"><div className="flex items-start justify-between"><div><div className="text-xs text-muted-foreground">{title}</div><div className="mt-2 text-xl md:text-2xl font-bold">{value}</div></div><div className="w-10 h-10 rounded-lg grid place-items-center bg-water-soft text-water">{icon}</div></div></CardContent></Card>; }
function Process({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) { return <div className="rounded-lg border p-3 min-w-0"><div className="flex items-center gap-1 text-[11px] text-muted-foreground">{icon}<span className="truncate">{label}</span></div><div className="mt-1 text-lg font-bold">{fmtNum(value)}</div></div>; }
