import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, Camera, MapPin, ShieldAlert, Image as ImageIcon, WifiOff, RefreshCw } from "lucide-react";
import { fmtYER, priceFor } from "@/lib/pricing";
import { MeterCamera, type OcrResult } from "@/components/meter-camera";
import { addPending, syncPending, useOnlineStatus, usePendingCount } from "@/lib/sync";
import { useAuth } from "@/lib/auth";
import { getGeoFix, type GeoFix } from "@/lib/geolocation";
import { listMetersAndCustomers, listReadings, listBills, getLatestApprovedReading, recordReading, type DbMeter, type DbCustomer, type DbReading, type DbBill } from "@/lib/authoritative";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/readings")({ head: () => ({ meta: [{ title: "القراءات — ميزان" }] }), component: ReadingsPage });

function ReadingsPage() {
  const { user } = useAuth();
  const online = useOnlineStatus();
  const pendingOffline = usePendingCount();
  const [meters, setMeters] = useState<DbMeter[]>([]);
  const [customers, setCustomers] = useState<DbCustomer[]>([]);
  const [readings, setReadings] = useState<DbReading[]>([]);
  const [bills, setBills] = useState<DbBill[]>([]);
  const [meterId, setMeterId] = useState("");
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState("");
  const [photo, setPhoto] = useState<string | undefined>();
  const [ocrSerial, setOcrSerial] = useState<string | undefined>();
  const [ocrConfidence, setOcrConfidence] = useState<number | undefined>();
  const [ocrRawText, setOcrRawText] = useState<string | undefined>();
  const [geo, setGeo] = useState<GeoFix | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [tab, setTab] = useState<"input" | "log">("input");

  const load = useCallback(async () => {
    const [{ meters: ms, customers: cs }, rs, bs] = await Promise.all([listMetersAndCustomers(), listReadings(), listBills()]);
    setMeters(ms); setCustomers(cs); setReadings(rs); setBills(bs);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const channel = supabase.channel("readings-page").on("postgres_changes", { event: "*", schema: "public", table: "water_readings" }, () => void load()).on("postgres_changes", { event: "*", schema: "public", table: "water_bills" }, () => void load()).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [load]);

  const selected = meters.find((m) => m.id === meterId) ?? null;
  const customer = selected ? customers.find((c) => c.id === selected.customer_id) ?? null : null;
  const last = selected ? readings.find((r) => r.meter_id === selected.id && r.status === "approved") ?? null : null;
  const pending = useMemo(() => readings.filter((r) => r.status === "pending"), [readings]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/[\s-]/g, "");
    return meters.filter((m) => {
      const c = customers.find((x) => x.id === m.customer_id);
      if (!q) return true;
      return m.serial_number.toLowerCase().replace(/[\s-]/g, "").includes(q) || (c?.name ?? "").toLowerCase().includes(query.trim().toLowerCase());
    }).slice(0, 20);
  }, [meters, customers, query]);

  function handleOcr(res: OcrResult) {
    setCameraOpen(false); setPhoto(res.imageData); setOcrSerial(res.serial ?? undefined); setOcrConfidence(res.confidence); setOcrRawText(res.raw);
    if (res.serialMatch === "mismatch") { toast.error(`رفض: رقم العداد ${res.serial} لا يطابق ${selected?.serial_number ?? "العداد المحدد"}`); return; }
    if (res.reading != null) setCurrent(String(res.reading));
    if (res.confidence < 0.7 || res.reading == null) toast.warning("الثقة غير كافية؛ راجع القراءة وأدخلها يدوياً. لا يوجد تخمين تلقائي.");
  }

  async function captureGeo() {
    setGeoBusy(true);
    try { const fix = await getGeoFix(); setGeo(fix); toast.success(`تم تحديد الموقع بدقة تقريبية ${fix.accuracy.toFixed(0)} م`); }
    catch (e) { toast.error(`فشل تحديد الموقع: ${(e as Error).message}`); }
    finally { setGeoBusy(false); }
  }

  async function saveReading() {
    if (!selected) return toast.error("اختر عداداً فعّالاً");
    const value = Number(current);
    if (!Number.isFinite(value) || value < 0) return toast.error("القراءة الحالية غير صالحة");
    if (ocrSerial && ocrSerial.replace(/[-\s]/g, "").toUpperCase() !== selected.serial_number.replace(/[-\s]/g, "").toUpperCase()) return toast.error("رقم العداد المصوّر لا يطابق العداد المحدد");
    let fix = geo;
    if (!fix) { setGeoBusy(true); try { fix = await getGeoFix(); setGeo(fix); } catch (e) { if (user?.role === "reader") { setGeoBusy(false); return toast.error(`GPS مطلوب للقارئ: ${(e as Error).message}`); } } finally { setGeoBusy(false); } }
    const clientId = crypto.randomUUID();
    const payload = { meterId: selected.id, current: value, imageData: photo, by: user?.name, latitude: fix?.lat ?? 0, longitude: fix?.lng ?? 0, accuracy: fix?.accuracy, ocrSerial, ocrConfidence, ocrRawText, captureSource: photo ? "camera" as const : "manual" as const, clientId };
    setBusy(true);
    try {
      if (!online) {
        await addPending(payload);
        toast.warning("أوفلاين: حُفظت العملية في قائمة المزامنة الآمنة، ولن تُعتبر مسجلة حتى يقبلها الخادم.");
      } else {
        const result = await recordReading({ meterId: selected.id, current: value, photoUrl: photo, captureSource: payload.captureSource, ocrSerial, ocrConfidence, ocrRawText, clientId, lat: fix?.lat, lng: fix?.lng, accuracy: fix?.accuracy });
        toast.success(`تم التسجيل في قاعدة البيانات • استهلاك ${result.consumption} • فاتورة ${result.bill_id}`);
        await load();
      }
      resetForm();
    } catch (e) { toast.error(e instanceof Error ? e.message : "تعذر تسجيل القراءة"); }
    finally { setBusy(false); }
  }

  async function retrySync() {
    setBusy(true);
    try { const r = await syncPending(); toast.success(`المزامنة: ${r.synced} ناجحة، ${r.failed} فاشلة`); await load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "تعذرت المزامنة"); }
    finally { setBusy(false); }
  }

  function resetForm() { setCurrent(""); setPhoto(undefined); setOcrSerial(undefined); setOcrConfidence(undefined); setOcrRawText(undefined); setGeo(null); }

  return <div className="space-y-6">
    <div className="flex justify-between items-start gap-3"><div><h1 className="text-2xl md:text-3xl font-bold">القراءات</h1><p className="text-sm text-muted-foreground mt-1">المسار التشغيلي الموحّد: تصوير أو إدخال يدوي → تحقق → قاعدة البيانات → فاتورة</p></div><div className="flex gap-2">{!online && <Badge variant="destructive" className="gap-1"><WifiOff className="w-3 h-3"/> أوفلاين</Badge>}{pendingOffline > 0 && <Badge variant="secondary">معلّق محلياً: {pendingOffline}</Badge>}<Button variant="outline" onClick={() => void retrySync()} disabled={busy || !online}><RefreshCw className="w-4 h-4 ms-1"/> مزامنة</Button></div></div>
    <div className="flex gap-2"><Button size="sm" variant={tab === "input" ? "default" : "outline"} onClick={() => setTab("input")}>إدخال</Button><Button size="sm" variant={tab === "log" ? "default" : "outline"} onClick={() => setTab("log")}>سجل قاعدة البيانات ({readings.length})</Button></div>
    {tab === "input" && <Card><CardHeader><CardTitle>تسجيل قراءة موثقة</CardTitle></CardHeader><CardContent className="space-y-4">
      <div><Label>العداد</Label><Input placeholder="ابحث باسم المشترك أو رقم العداد" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <div className="border rounded-lg mt-1 max-h-60 overflow-auto">{results.map(m => { const c = customers.find(x => x.id === m.customer_id); return <button key={m.id} type="button" className="w-full text-right p-3 hover:bg-accent border-b" onClick={() => { setMeterId(m.id); setQuery(`${c?.name ?? ""} · ${m.serial_number}`); }}>{c?.name} — <span className="font-mono">{m.serial_number}</span></button>; })}</div>}</div>
      {selected && <div className="rounded-lg border p-3 bg-muted/30 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs"><Info label="المشترك">{customer?.name ?? "—"}</Info><Info label="رقم العداد"><span className="font-mono">{selected.serial_number}</span></Info><Info label="القراءة السابقة"><span className="font-mono">{last?.current_reading ?? 0}</span></Info><Info label="الحالة"><Badge variant="outline">فعّال</Badge></Info></div>}
      <div className="flex gap-2"><Button variant="outline" onClick={() => void captureGeo()} disabled={geoBusy}><MapPin className="w-4 h-4 ms-1"/> {geo ? `الموقع ${geo.accuracy.toFixed(0)}م` : "تحديد الموقع"}</Button><Button variant="outline" onClick={() => setCameraOpen(true)}><Camera className="w-4 h-4 ms-1"/> تصوير + OCR</Button></div>
      <div className="grid md:grid-cols-3 gap-3 items-end"><div className="md:col-span-2"><Label>القراءة الحالية</Label><Input inputMode="decimal" type="number" min="0" step="any" value={current} onChange={(e) => setCurrent(e.target.value)} />{selected && current && Number(current) >= (last?.current_reading ?? 0) && <p className="text-[11px] text-muted-foreground mt-1">الاستهلاك المحسوب على الخادم سيبدأ من {last?.current_reading ?? 0}؛ تقدير محلي فقط: {Number(current) - (last?.current_reading ?? 0)} — {fmtYER(priceFor("water", Number(current) - (last?.current_reading ?? 0)))}</p>}</div><Button size="lg" onClick={() => void saveReading()} disabled={busy || geoBusy}>{busy ? "جارٍ الحفظ..." : "حفظ القراءة"}</Button></div>
      {(photo || ocrSerial || geo) && <div className="flex flex-wrap gap-2 text-xs">{photo && <Badge variant="outline"><ImageIcon className="w-3 h-3 ms-1"/> صورة</Badge>}{ocrSerial && <Badge variant="outline"><ShieldAlert className="w-3 h-3 ms-1"/> OCR: {ocrSerial} ({Math.round((ocrConfidence ?? 0) * 100)}%)</Badge>}{geo && <Badge variant="outline"><MapPin className="w-3 h-3 ms-1"/> {geo.lat.toFixed(4)}, {geo.lng.toFixed(4)}</Badge>}</div>}
    </CardContent></Card>}
    <MeterCamera open={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={handleOcr} expectedSerial={selected?.serial_number ?? null}/>
    {tab === "log" && <Card><CardHeader><CardTitle>القراءات من قاعدة البيانات</CardTitle></CardHeader><CardContent className="overflow-auto"><Table><TableHeader><TableRow><TableHead>التاريخ</TableHead><TableHead>العداد</TableHead><TableHead>المشترك</TableHead><TableHead>السابقة</TableHead><TableHead>الحالية</TableHead><TableHead>الاستهلاك</TableHead><TableHead>الحالة</TableHead></TableRow></TableHeader><TableBody>{readings.map(r => { const c = customers.find(x => x.id === r.customer_id); return <TableRow key={r.id}><TableCell className="text-xs">{new Date(r.created_at).toLocaleString("ar-YE")}</TableCell><TableCell className="font-mono">{r.meter_number}</TableCell><TableCell>{c?.name ?? "—"}</TableCell><TableCell>{r.previous}</TableCell><TableCell>{r.current_reading}</TableCell><TableCell className="font-semibold">{r.consumption}</TableCell><TableCell>{r.status === "approved" ? <Badge variant="outline" className="gap-1"><CheckCircle2 className="w-3 h-3"/> معتمدة</Badge> : r.status === "rejected" ? <Badge variant="destructive"><AlertCircle className="w-3 h-3"/> مرفوضة</Badge> : <Badge variant="secondary">معلقة</Badge>}</TableCell></TableRow>})}</TableBody></Table></CardContent></Card>}
    {pending.length > 0 && <div className="rounded-lg border border-amber-400/40 bg-amber-50/30 p-3 text-sm">توجد {pending.length} قراءة بحالة معلقة في الخادم. لا تُدخل في مؤشرات الاعتماد حتى اعتمادها.</div>}
  </div>;
}
function Info({ label, children }: { label: string; children: React.ReactNode }) { return <div><div className="text-muted-foreground text-[10px]">{label}</div><div className="font-medium mt-0.5">{children}</div></div>; }
