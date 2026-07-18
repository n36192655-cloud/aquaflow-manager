import { createFileRoute } from "@tanstack/react-router";
import { useStore } from "@/lib/store";
import { fmtYER, fmtNum } from "@/lib/pricing";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Droplets, Users, AlertTriangle, Receipt, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, CartesianGrid, Legend } from "recharts";

export const Route = createFileRoute("/")({ component: Dashboard });

function Dashboard() {
  const { customers, meters, readings, bills, payments } = useStore();

  const paid = bills.filter((b) => b.status === "paid");
  const unpaid = bills.filter((b) => b.status !== "paid");
  const totalRevenue = payments.reduce((a, b) => a + b.amount, 0) + paid.reduce((a, b) => a + b.total, 0);
  const outstanding = unpaid.reduce((a, b) => a + b.total, 0);

  const waterCons = readings.reduce((a, b) => a + b.consumption, 0);
  const suspicious = readings.filter((r) => r.flag !== "ok");

  const byMeter = new Map<number, number>();
  readings.forEach((r) => {
    byMeter.set(r.meter_id, (byMeter.get(r.meter_id) ?? 0) + r.consumption);
  });
  const chartData = meters.slice(0, 10).map((m) => {
    const c = customers.find((c) => c.id === m.customer_id);
    return {
      name: c?.name.split(" ")[0] ?? m.number,
      water: byMeter.get(m.id) ?? 0,
    };
  });

  const revPie = [
    { name: "مدفوع", value: paid.reduce((a, b) => a + b.total, 0) },
    { name: "غير مدفوع", value: outstanding },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">لوحة التحكم</h1>
        <p className="text-sm text-muted-foreground mt-1">نظرة شاملة على شبكة المياه — تعز</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="إجمالي الإيرادات" value={fmtYER(totalRevenue)} icon={<TrendingUp className="w-5 h-5" />} />
        <StatCard title="مستحقات غير محصلة" value={fmtYER(outstanding)} icon={<Receipt className="w-5 h-5" />} />
        <StatCard title="استهلاك المياه" value={`${fmtNum(waterCons)} م³`} icon={<Droplets className="w-5 h-5" />} />
        <StatCard title="مشتركون" value={fmtNum(customers.length)} icon={<Users className="w-5 h-5" />} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MiniCard label="عدادات نشطة" value={meters.filter((m) => m.status === "active").length} icon={<Droplets className="w-4 h-4" />} />
        <MiniCard label="فواتير" value={bills.length} icon={<Receipt className="w-4 h-4" />} />
        <MiniCard label="مدفوعات" value={payments.length} icon={<TrendingUp className="w-4 h-4" />} />
        <MiniCard label="تنبيهات" value={suspicious.length} icon={<AlertTriangle className="w-4 h-4" />} highlight={suspicious.length > 0} />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>الاستهلاك حسب المشترك</CardTitle></CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="water" name="مياه (م³)" fill="var(--water)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>حالة التحصيل</CardTitle></CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={revPie} dataKey="value" innerRadius={55} outerRadius={90} paddingAngle={2}>
                  <Cell fill="var(--water)" />
                  <Cell fill="var(--muted-foreground)" />
                </Pie>
                <Tooltip formatter={(v: number) => fmtYER(v)} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-destructive" /> تنبيهات ذكية</CardTitle>
          <Badge variant="outline">{suspicious.length}</Badge>
        </CardHeader>
        <CardContent>
          {suspicious.length === 0 ? (
            <p className="text-sm text-muted-foreground">لا توجد قراءات شاذة حالياً. النظام يراقب استهلاك المياه تلقائياً ويكشف: التسرب، التلاعب، والقفزات غير الطبيعية (أكثر من 3× المتوسط).</p>
          ) : (
            <ul className="space-y-2">
              {suspicious.slice(0, 10).map((r) => {
                const m = meters.find((x) => x.id === r.meter_id);
                const c = customers.find((x) => x.id === m?.customer_id);
                return (
                  <li key={r.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/40 text-sm">
                    <div>
                      <span className="font-semibold">{c?.name}</span> — عداد {m?.number}
                    </div>
                    <Badge variant={r.flag === "error" ? "destructive" : "secondary"}>
                      {r.flag === "error" ? "قراءة خاطئة" : "استهلاك مشبوه"}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs text-muted-foreground">{title}</div>
            <div className="mt-2 text-xl md:text-2xl font-bold">{value}</div>
          </div>
          <div className="w-10 h-10 rounded-lg grid place-items-center" style={{ background: "var(--water-soft)", color: "var(--water)" }}>{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function MiniCard({ label, value, icon, highlight }: { label: string; value: number; icon: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={`p-4 rounded-xl border ${highlight ? "border-destructive/40 bg-destructive/5" : "bg-card"}`}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}<span>{label}</span></div>
      <div className={`mt-1 text-2xl font-bold ${highlight ? "text-destructive" : ""}`}>{fmtNum(value)}</div>
    </div>
  );
}
