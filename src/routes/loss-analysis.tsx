import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { AlertTriangle, Droplets, Zap, Trash2, Camera, TrendingDown } from "lucide-react";
import { fmtNum } from "@/lib/pricing";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import type { MeterType } from "@/lib/pricing";

export const Route = createFileRoute("/loss-analysis")({
  head: () => ({ meta: [{ title: "تحليل الفاقد — ميزان" }] }),
  component: LossAnalysisPage,
});

const LOSS_THRESHOLD = 15; // % — operational threshold

function todayISO() { return new Date().toISOString().slice(0, 10); }
function monthAgoISO() {
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}

function LossAnalysisPage() {
  const { productionLogs, addProductionLog, deleteProductionLog, readings, meters } = useStore();
  const [type, setType] = useState<MeterType>("water");
  const [units, setUnits] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<string | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);

  const [from, setFrom] = useState(monthAgoISO());
  const [to, setTo] = useState(todayISO());

  function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setPhoto(String(reader.result));
    reader.readAsDataURL(f);
  }

  function submit() {
    const n = Number(units);
    if (!n || n <= 0) return toast.error("أدخل قيمة إنتاج صحيحة");
    addProductionLog({ type, units: n, note, photo, date: new Date().toISOString() });
    setUnits(""); setNote(""); setPhoto(undefined);
    if (fileRef.current) fileRef.current.value = "";
    toast.success("تم تسجيل الإنتاج");
  }

  const analytics = useMemo(() => {
    const fromT = new Date(from).getTime();
    const toT = new Date(to).getTime() + 24 * 3600 * 1000 - 1;
    const inRange = (d: string) => {
      const t = new Date(d).getTime();
      return t >= fromT && t <= toT;
    };
    const perType = (t: MeterType) => {
      const produced = productionLogs.filter((p) => p.type === t && inRange(p.date)).reduce((a, b) => a + b.units, 0);
      const metersOfType = new Set(meters.filter((m) => m.type === t).map((m) => m.id));
      const consumed = readings.filter((r) => metersOfType.has(r.meter_id) && inRange(r.date)).reduce((a, b) => a + b.consumption, 0);
      const loss = Math.max(0, produced - consumed);
      const pct = produced > 0 ? (loss / produced) * 100 : 0;
      return { produced, consumed, loss, pct };
    };
    return { water: perType("water"), electric: perType("electric") };
  }, [productionLogs, readings, meters, from, to]);

  const chartData = [
    { name: "المياه (م³)", produced: analytics.water.produced, consumed: analytics.water.consumed, loss: analytics.water.loss },
    { name: "الكهرباء (ك.و.س)", produced: analytics.electric.produced, consumed: analytics.electric.consumed, loss: analytics.electric.loss },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">تحليل الفاقد والتسرب</h1>
        <p className="text-sm text-muted-foreground mt-1">قياس الفرق بين الإنتاج الكلي من المصدر واستهلاك المشتركين</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">تسجيل إنتاج جديد</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>النوع</Label>
                <Select value={type} onValueChange={(v: MeterType) => setType(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="water">مياه (المضخة الرئيسية)</SelectItem>
                    <SelectItem value="electric">كهرباء (المولّد الرئيسي)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>إجمالي الوحدات</Label>
                <Input type="number" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="مثال: 12500" />
              </div>
            </div>
            <div>
              <Label>ملاحظة</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثال: قراءة عداد المضخة الرئيسية بتاريخ..." />
            </div>
            <div>
              <Label>تصوير العداد الرئيسي</Label>
              <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onPickPhoto}
                className="block w-full text-xs file:me-2 file:py-1.5 file:px-3 file:rounded-md file:border file:bg-muted file:text-foreground" />
              {photo && <img src={photo} alt="عداد رئيسي" className="mt-2 h-32 w-full object-cover rounded-lg border" />}
            </div>
            <Button onClick={submit} className="w-full"><Camera className="w-4 h-4 ms-1" /> حفظ الإنتاج</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">فلترة الفترة</CardTitle></CardHeader>
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
            <div className="grid grid-cols-2 gap-3 pt-2">
              <LossStat label="فاقد المياه" pct={analytics.water.pct} loss={analytics.water.loss} unit="م³" icon={<Droplets className="w-4 h-4" />} />
              <LossStat label="فاقد الكهرباء" pct={analytics.electric.pct} loss={analytics.electric.loss} unit="ك.و.س" icon={<Zap className="w-4 h-4" />} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">المُنتج مقابل المُفوتر</CardTitle></CardHeader>
        <CardContent className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => fmtNum(v)} />
              <Legend />
              <Bar dataKey="produced" name="مُنتج" fill="var(--water)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="consumed" name="مُستهلك" fill="var(--electric-2)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="loss" name="فاقد" fill="#dc2626" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {(analytics.water.pct > LOSS_THRESHOLD || analytics.electric.pct > LOSS_THRESHOLD) && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-destructive mt-0.5" />
            <div className="text-sm">
              <div className="font-semibold">تنبيه ذكي — نسبة الفاقد مرتفعة</div>
              <div className="text-muted-foreground mt-1">
                {analytics.water.pct > LOSS_THRESHOLD && <div>فاقد المياه {analytics.water.pct.toFixed(1)}% — يوصى بفحص شبكة التوزيع لاحتمال وجود تسرب أو استهلاك غير مُقاس.</div>}
                {analytics.electric.pct > LOSS_THRESHOLD && <div>فاقد الكهرباء {analytics.electric.pct.toFixed(1)}% — قد يشير إلى توصيلات غير قانونية أو خلل في العدادات.</div>}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">سجلات الإنتاج</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {productionLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">لا توجد سجلات بعد.</p>
          ) : (
            productionLogs.slice().sort((a, b) => +new Date(b.date) - +new Date(a.date)).map((p) => (
              <div key={p.id} className="flex items-center gap-3 p-3 border rounded-lg">
                {p.photo ? <img src={p.photo} alt="" className="w-12 h-12 object-cover rounded" /> : <div className="w-12 h-12 bg-muted rounded grid place-items-center"><TrendingDown className="w-4 h-4 text-muted-foreground" /></div>}
                <div className="flex-1 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant={p.type === "water" ? "default" : "secondary"}>{p.type === "water" ? "مياه" : "كهرباء"}</Badge>
                    <span className="font-semibold">{fmtNum(p.units)}</span>
                    <span className="text-xs text-muted-foreground">{new Date(p.date).toLocaleString("ar")}</span>
                  </div>
                  {p.note && <div className="text-xs text-muted-foreground mt-0.5">{p.note}</div>}
                </div>
                <Button size="icon" variant="ghost" onClick={() => deleteProductionLog(p.id)}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LossStat({ label, pct, loss, unit, icon }: { label: string; pct: number; loss: number; unit: string; icon: React.ReactNode }) {
  const danger = pct > LOSS_THRESHOLD;
  return (
    <div className={`p-3 rounded-lg border ${danger ? "border-destructive/40 bg-destructive/5" : "bg-muted/30"}`}>
      <div className="text-xs text-muted-foreground flex items-center gap-1">{icon}{label}</div>
      <div className={`text-xl font-bold mt-1 ${danger ? "text-destructive" : ""}`}>{pct.toFixed(1)}%</div>
      <div className="text-[11px] text-muted-foreground">{fmtNum(loss)} {unit}</div>
    </div>
  );
}