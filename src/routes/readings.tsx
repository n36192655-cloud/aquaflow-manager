import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { AlertCircle, Camera, Check, CheckCircle2, Image as ImageIcon, MapPin, RefreshCw, ShieldAlert, WifiOff, X } from "lucide-react";
import { MeterCamera, type OcrResult } from "@/components/meter-camera";
import { useAuth } from "@/lib/auth";
import { useOnlineStatus, addPending, getPending, removePending, syncPending, type PendingReading } from "@/lib/sync";
import { approveFieldReading, createMeterReadingImageUrl, newClientId, recordFieldReading, rejectFieldReading, removeMeterReadingImage, uploadMeterReadingImage } from "@/lib/field-ops";
import { supabase } from "@/lib/supabase";
import { getGeoFix, type GeoFix } from "@/lib/geolocation";

export const Route = createFileRoute("/readings")({
  head: () => ({ meta: [{ title: "القراءات — ميزان" }] }),
  component: ReadingsPage,
});

type Customer = { id: string; name: string; phone: string | null; address: string | null };
type Meter = { id: string; customer_id: string; serial_number: string; status: string; profile_id: string | null };
type Profile = { id: string; name: string; integer_digits: number; decimal_digits: number; display_type: string; color_semantics: unknown };
type Reading = { id: string; meter_id: string | null; customer_id: string | null; previous: number; current_reading: number; consumption: number; status: string; verification_status: string; photo_url: string | null; ocr_serial: string | null; ocr_confidence: number | null; lat: number | null; lng: number | null; review_reason: string | null; created_at: string };
type Bill = { id: string; customer_id: string; reading_id: string | null; total: number; arrears: number; status: string; issued_at: string };

function isTransientError(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status?: unknown }).status) : NaN;
  if (Number.isFinite(status)) return status === 429 || status >= 500;
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|network|timeout|offline|fetch failed/i.test(message);
}

function normalizeSerial(value: string): string { return value.replace(/[^A-Z0-9]/gi, "").toUpperCase(); }

function decimalPlaces(value: string): number {
  const normalized = value.trim().replace(",", ".");
  const index = normalized.indexOf(".");
  return index === -1 ? 0 : normalized.length - index - 1;
}

function ReadingsPage() {
  const { user } = useAuth();
  const online = useOnlineStatus();
  const isReader = user?.role === "reader";
  const isManager = user?.role === "admin";
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [meters, setMeters] = useState<Meter[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [selectedMeterId, setSelectedMeterId] = useState("");
  const [current, setCurrent] = useState("");
  const [search, setSearch] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [photo, setPhoto] = useState<string | undefined>();
  const [ocrSerial, setOcrSerial] = useState<string | undefined>();
  const [ocrRawText, setOcrRawText] = useState<string | undefined>();
  const [ocrConfidence, setOcrConfidence] = useState<number | undefined>();
  const [geo, setGeo] = useState<GeoFix | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingOffline, setPendingOffline] = useState<PendingReading[]>([]);
  const [tab, setTab] = useState<"input" | "pending" | "history">("input");

  async function loadData() {
    if (!user?.tenantId) return;
    const [customerResult, meterResult, profileResult, readingResult, billResult] = await Promise.all([
      supabase.from("customers").select("id,name,phone,address").eq("tenant_id", user.tenantId).eq("status", "active").order("name"),
      supabase.from("meters").select("id,customer_id,serial_number,status,profile_id").eq("tenant_id", user.tenantId).order("serial_number"),
      supabase.from("meter_profiles").select("id,name,integer_digits,decimal_digits,display_type,color_semantics").eq("tenant_id", user.tenantId),
      supabase.from("water_readings").select("id,meter_id,customer_id,previous,current_reading,consumption,status,verification_status,photo_url,ocr_serial,ocr_confidence,lat,lng,review_reason,created_at").eq("tenant_id", user.tenantId).order("created_at", { ascending: false }),
      supabase.from("water_bills").select("id,customer_id,reading_id,total,arrears,status,issued_at").eq("tenant_id", user.tenantId).order("issued_at", { ascending: false }),
    ]);
    const firstError = [customerResult, meterResult, profileResult, readingResult, billResult].find((x) => x.error)?.error;
    if (firstError) throw firstError;
    setCustomers((customerResult.data ?? []) as Customer[]);
    setMeters((meterResult.data ?? []) as Meter[]);
    setProfiles((profileResult.data ?? []) as Profile[]);
    setReadings((readingResult.data ?? []) as Reading[]);
    setBills((billResult.data ?? []) as Bill[]);
  }

  async function refreshOffline() {
    try { setPendingOffline(await getPending()); } catch (error) { console.error(error); }
  }

  useEffect(() => {
    void loadData().catch((error) => toast.error(`تعذر تحميل بيانات التشغيل: ${error.message}`));
    void refreshOffline();
    const channel = supabase.channel(`mizan-readings-${user?.tenantId ?? "none"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "water_readings", filter: `tenant_id=eq.${user?.tenantId ?? ""}` }, () => void loadData())
      .on("postgres_changes", { event: "*", schema: "public", table: "water_bills", filter: `tenant_id=eq.${user?.tenantId ?? ""}` }, () => void loadData())
      .subscribe();
    const refresh = () => { void refreshOffline(); void loadData(); };
    window.addEventListener("mizan-pending-updated", refresh);
    return () => { window.removeEventListener("mizan-pending-updated", refresh); void supabase.removeChannel(channel); };
  }, [user?.tenantId]);

  const filteredMeters = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return meters;
    return meters.filter((meter) => {
      const customer = customers.find((x) => x.id === meter.customer_id);
      return meter.serial_number.toLowerCase().includes(q) || customer?.name.toLowerCase().includes(q);
    });
  }, [meters, customers, search]);

  const selected = meters.find((meter) => meter.id === selectedMeterId) ?? null;
  const selectedCustomer = selected ? customers.find((customer) => customer.id === selected.customer_id) : null;
  const selectedProfile = selected?.profile_id ? profiles.find((profile) => profile.id === selected.profile_id) : null;
  const approvedHistory = selected ? readings.filter((reading) => reading.meter_id === selected.id && reading.verification_status === "approved") : [];
  const previous = approvedHistory[0]?.current_reading ?? 0;
  const pending = readings.filter((reading) => reading.verification_status === "pending");

  function handleOcr(result: OcrResult) {
    setCameraOpen(false);
    setPhoto(result.imageData);
    setOcrSerial(result.serial ?? undefined);
    setOcrRawText(result.raw);
    setOcrConfidence(result.confidence);
    if (result.reading != null) setCurrent(String(result.reading));
    if (result.serialMatch === "mismatch") toast.error(`رفض بصري: ${result.serial} لا يطابق ${selected?.serial_number}`);
    else if (result.confidence < 0.7 || result.reading == null) toast.warning("الثقة منخفضة؛ راجع القراءة وأدخلها يدوياً. لا يتم التخمين.");
  }

  async function captureGeo() {
    setGeoBusy(true);
    try { const fix = await getGeoFix(); setGeo(fix); toast.success(`تم تحديد الموقع بدقة ${fix.accuracy.toFixed(0)}م`); }
    catch (error) { toast.error(`فشل تحديد الموقع: ${(error as Error).message}`); }
    finally { setGeoBusy(false); }
  }

  function resetForm() {
    setCurrent(""); setPhoto(undefined); setOcrSerial(undefined); setOcrRawText(undefined); setOcrConfidence(undefined); setGeo(null);
  }

  async function saveReading() {
    if (!user?.userId || !user.tenantId) return toast.error("جلسة المستخدم غير صالحة");
    if (!selected) return toast.error("اختر عداداً فعّالاً");
    const numeric = Number(current);
    if (!Number.isFinite(numeric) || numeric < 0) return toast.error("القراءة الحالية غير صالحة");
    if (selectedProfile && decimalPlaces(current) > selectedProfile.decimal_digits) return toast.error(`هذا العداد يسمح حتى ${selectedProfile.decimal_digits} منازل عشرية فقط`);
    if (ocrSerial && normalizeSerial(ocrSerial) !== normalizeSerial(selected.serial_number)) return toast.error("رقم العداد الملتقط لا يطابق العداد المسجل");
    if (isReader && !geo) return toast.error("الموقع الجغرافي مطلوب للقارئ");
    let fix = geo;
    if (!fix) {
      try { fix = await getGeoFix(); setGeo(fix); } catch (error) { if (isReader) return toast.error(`الموقع مطلوب: ${(error as Error).message}`); }
    }

    const clientId = newClientId("reading");
    const common = {
      clientId,
      tenantId: user.tenantId,
      userId: user.userId,
      meterId: selected.id,
      current: numeric,
      imageData: photo,
      by: user.name,
      latitude: fix?.lat,
      longitude: fix?.lng,
      accuracy: fix?.accuracy,
      captureSource: photo ? "camera" as const : "manual" as const,
      ocrSerial,
      ocrConfidence,
      ocrRawText,
    };

    if (!online) {
      await addPending(common);
      await refreshOffline();
      toast.warning("تم حفظ القراءة محلياً في قائمة انتظار آمنة؛ لم تُسجل في قاعدة البيانات بعد.");
      resetForm();
      return;
    }

    setBusy(true);
    let uploadedPath: string | undefined;
    try {
      if (photo) uploadedPath = await uploadMeterReadingImage(photo, user.tenantId, user.userId, clientId);
      const result = await recordFieldReading({
        meterId: selected.id,
        current: numeric,
        photoUrl: uploadedPath,
        captureSource: photo ? "camera" : "manual",
        ocrSerial,
        ocrConfidence,
        ocrRawText,
        clientId,
        lat: fix?.lat,
        lng: fix?.lng,
        accuracy: fix?.accuracy,
      });
      toast.success(`تم تسجيل القراءة #${result.reading_id} بانتظار اعتماد المدير. لم تُصدر فاتورة قبل الاعتماد.`);
      resetForm();
      await loadData();
    } catch (error) {
      if (uploadedPath) await removeMeterReadingImage(uploadedPath);
      if (isTransientError(error)) {
        await addPending(common);
        await refreshOffline();
        toast.warning("تعذر الوصول إلى الخادم الآن؛ حُفظت القراءة محلياً ولم تُعتبر مسجلة حتى تتم المزامنة.");
      } else {
        toast.error(`رفض الخادم القراءة: ${(error as Error).message}`);
      }
    } finally { setBusy(false); }
  }

  async function approve(readingId: string) {
    setBusy(true);
    try { await approveFieldReading(readingId); toast.success("تم اعتماد القراءة وإصدار الفاتورة ذرّياً"); await loadData(); }
    catch (error) { toast.error(`فشل الاعتماد: ${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function reject(readingId: string) {
    const reason = window.prompt("سبب رفض القراءة (مطلوب)")?.trim();
    if (!reason) return;
    setBusy(true);
    try { await rejectFieldReading(readingId, reason); toast.info("تم رفض القراءة وتسجيل السبب"); await loadData(); }
    catch (error) { toast.error(`فشل الرفض: ${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function retryOffline() {
    setBusy(true);
    try {
      const result = await syncPending();
      await refreshOffline();
      await loadData();
      if (result.synced) toast.success(`تمت مزامنة ${result.synced} قراءة إلى الخادم`);
      if (result.failed) toast.warning(`فشلت مزامنة ${result.failed} قراءة؛ بقيت في الطابور مع سبب الخطأ`);
      if (!result.synced && !result.failed) toast.info("لا توجد قراءة قابلة للمزامنة الآن");
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div><h1 className="text-2xl md:text-3xl font-bold">القراءات</h1><p className="text-sm text-muted-foreground mt-1">مسار إنتاجي: تحقق → GPS → خادم → اعتماد → فاتورة</p></div>
        <div className="flex items-center gap-2">{!online && <Badge variant="destructive"><WifiOff className="w-3 h-3 ms-1"/> أوفلاين</Badge>}<Button size="sm" variant="outline" onClick={() => void retryOffline()} disabled={busy}><RefreshCw className="w-4 h-4 ms-1"/> مزامنة</Button></div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant={tab === "input" ? "default" : "outline"} onClick={() => setTab("input")}>إدخال</Button>
        {isManager && <Button size="sm" variant={tab === "pending" ? "default" : "outline"} onClick={() => setTab("pending")}>بانتظار الاعتماد {pending.length > 0 && <Badge className="ms-1" variant="secondary">{pending.length}</Badge>}</Button>}
        <Button size="sm" variant={tab === "history" ? "default" : "outline"} onClick={() => setTab("history")}>السجل</Button>
      </div>

      {tab === "input" && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between"><CardTitle>تسجيل قراءة</CardTitle><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void captureGeo()} disabled={geoBusy}><MapPin className="w-4 h-4 ms-1"/>{geo ? "الموقع مثبت" : "تحديد الموقع"}</Button><Button size="sm" variant="outline" onClick={() => setCameraOpen(true)} disabled={!selected}><Camera className="w-4 h-4 ms-1"/> تصوير + OCR</Button></div></CardHeader>
          <CardContent className="space-y-4">
            {meters.length === 0 && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 flex gap-2"><AlertCircle className="w-5 h-5 shrink-0"/><div><b>لا توجد عدادات فعلية مرتبطة بالمشروع في قاعدة البيانات.</b><div className="mt-1">لن يتم إنشاء قراءة وهمية أو استخدام بيانات الاختبار. يجب إدخال العدادات الحقيقية عبر مسار الإدارة قبل بدء القراءة الميدانية.</div></div></div>}
            <div><Label>بحث المشترك / رقم العداد</Label><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="اكتب اسم المشترك أو رقم العداد" className="mt-1"/></div>
            <div><Label>العداد</Label><select className="mt-1 w-full h-10 rounded-md border bg-background px-3 text-sm" value={selectedMeterId} onChange={(e) => { setSelectedMeterId(e.target.value); setOcrSerial(undefined); }} disabled={!meters.length}><option value="">اختر عداداً فعّالاً</option>{filteredMeters.filter((m) => m.status === "active").map((meter) => { const customer = customers.find((c) => c.id === meter.customer_id); return <option key={meter.id} value={meter.id}>{customer?.name ?? "مشترك غير معروف"} — {meter.serial_number}</option>; })}</select></div>
            {selected && selectedCustomer && <div className="grid grid-cols-2 md:grid-cols-4 gap-3 rounded-lg border bg-muted/30 p-3 text-xs"><Info label="المشترك">{selectedCustomer.name}</Info><Info label="الهاتف">{selectedCustomer.phone ?? "—"}</Info><Info label="رقم العداد"><span dir="ltr" className="font-mono">{selected.serial_number}</span></Info><Info label="القراءة السابقة"><span dir="ltr" className="font-mono">{previous}</span></Info></div>}
            {selectedProfile && <div className="text-xs text-muted-foreground">نوع العداد: {selectedProfile.display_type} · الأرقام الصحيحة: {selectedProfile.integer_digits || "غير محدد"} · الكسور: {selectedProfile.decimal_digits}</div>}
            <div className="grid md:grid-cols-[1fr_auto] gap-3 items-end"><div><Label>القراءة الحالية</Label><Input className="mt-1" type="number" step={selectedProfile?.decimal_digits ? "0.01" : "1"} value={current} onChange={(e) => setCurrent(e.target.value)} disabled={!selected}/></div><Button size="lg" onClick={() => void saveReading()} disabled={busy || !selected}>{busy ? "جاري المعالجة..." : "حفظ القراءة"}</Button></div>
            <div className="flex flex-wrap gap-2 text-xs">{photo && <Badge variant="outline"><ImageIcon className="w-3 h-3 ms-1"/> صورة</Badge>}{ocrSerial && <Badge variant={selected && normalizeSerial(ocrSerial) === normalizeSerial(selected.serial_number) ? "default" : "destructive"}><ShieldAlert className="w-3 h-3 ms-1"/> OCR: {ocrSerial}</Badge>}{ocrConfidence != null && <Badge variant="outline">ثقة OCR: {(ocrConfidence * 100).toFixed(0)}%</Badge>}{geo && <Badge variant="outline"><MapPin className="w-3 h-3 ms-1"/>{geo.accuracy.toFixed(0)}م</Badge>}</div>
          </CardContent>
        </Card>
      )}

      {tab === "pending" && isManager && <PendingApprovals readings={pending} customers={customers} meters={meters} bills={bills} busy={busy} onApprove={approve} onReject={reject} />}
      {tab === "history" && <History readings={readings} customers={customers} meters={meters} />}

      {pendingOffline.length > 0 && <Card><CardHeader><CardTitle className="flex items-center gap-2"><WifiOff className="w-4 h-4"/> طابور الأوفلاين ({pendingOffline.length})</CardTitle></CardHeader><CardContent className="space-y-2">{pendingOffline.map((item) => <div key={item.clientId} className="rounded-md border p-3 text-xs flex items-center justify-between gap-3"><div><div className="font-mono">{item.clientId}</div><div className="text-muted-foreground">قراءة {item.current} · محاولات {item.retryCount} · {item.state}</div>{item.lastError && <div className="text-destructive mt-1">{item.lastError}</div>}</div><Button size="sm" variant="outline" onClick={() => void retryOffline()} disabled={!online || busy}>إعادة المحاولة</Button></div>)}</CardContent></Card>}

      <MeterCamera open={cameraOpen} onClose={() => setCameraOpen(false)} onCapture={handleOcr} expectedSerial={selected?.serial_number ?? null} />
    </div>
  );
}

function PendingApprovals({ readings, customers, meters, bills, busy, onApprove, onReject }: { readings: Reading[]; customers: Customer[]; meters: Meter[]; bills: Bill[]; busy: boolean; onApprove: (id: string) => void; onReject: (id: string) => void }) {
  return <Card><CardHeader><CardTitle>قراءات بانتظار الاعتماد ({readings.length})</CardTitle></CardHeader><CardContent className="space-y-3">{readings.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">لا توجد قراءات معلقة.</p>}{readings.map((reading) => { const meter = meters.find((m) => m.id === reading.meter_id); const customer = customers.find((c) => c.id === reading.customer_id); const bill = bills.find((b) => b.reading_id === reading.id); return <PendingRow key={reading.id} reading={reading} meter={meter} customer={customer} bill={bill} busy={busy} onApprove={onApprove} onReject={onReject}/>; })}</CardContent></Card>;
}

function PendingRow({ reading, meter, customer, bill, busy, onApprove, onReject }: { reading: Reading; meter?: Meter; customer?: Customer; bill?: Bill; busy: boolean; onApprove: (id: string) => void; onReject: (id: string) => void }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => { if (reading.photo_url) void createMeterReadingImageUrl(reading.photo_url).then(setImageUrl); }, [reading.photo_url]);
  return <div className="rounded-lg border p-3 grid md:grid-cols-[120px_1fr_auto] gap-3 items-start"><div className="w-full h-24 rounded-md border bg-muted/30 grid place-items-center overflow-hidden">{imageUrl ? <img src={imageUrl} alt="صورة العداد" className="w-full h-full object-cover"/> : <ImageIcon className="w-5 h-5 text-muted-foreground"/>}</div><div className="text-xs space-y-1"><div className="font-semibold">{customer?.name ?? "مشترك"} — <span className="font-mono">{meter?.serial_number ?? "—"}</span></div><div>القراءة: {reading.previous} → <b>{reading.current_reading}</b> · الاستهلاك: {reading.consumption}</div><div>OCR: {reading.ocr_serial ?? "غير متوفر"} · الثقة: {reading.ocr_confidence == null ? "—" : `${(reading.ocr_confidence * 100).toFixed(0)}%`}</div><div>GPS: {reading.lat == null || reading.lng == null ? "غير متوفر" : `${reading.lat.toFixed(5)}, ${reading.lng.toFixed(5)}`}</div>{bill && <div>فاتورة موجودة: {bill.total}</div>}</div><div className="flex md:flex-col gap-2"><Button size="sm" onClick={() => onApprove(reading.id)} disabled={busy}><Check className="w-3 h-3 ms-1"/> اعتماد</Button><Button size="sm" variant="destructive" onClick={() => onReject(reading.id)} disabled={busy}><X className="w-3 h-3 ms-1"/> رفض</Button></div></div>;
}

function History({ readings, customers, meters }: { readings: Reading[]; customers: Customer[]; meters: Meter[] }) {
  return <Card><CardHeader><CardTitle>سجل القراءات ({readings.length})</CardTitle></CardHeader><CardContent className="space-y-2">{readings.length === 0 && <p className="text-sm text-muted-foreground py-6 text-center">لا توجد قراءات.</p>}{readings.map((reading) => { const meter = meters.find((m) => m.id === reading.meter_id); const customer = customers.find((c) => c.id === reading.customer_id); return <div key={reading.id} className="rounded-md border p-3 grid md:grid-cols-5 gap-2 text-xs"><div>{customer?.name ?? "—"}</div><div className="font-mono">{meter?.serial_number ?? reading.id}</div><div>{reading.previous} → {reading.current_reading}</div><div>{reading.consumption} م³</div><div><Badge variant={reading.verification_status === "approved" ? "default" : reading.verification_status === "rejected" ? "destructive" : "secondary"}>{reading.verification_status === "approved" ? "معتمدة" : reading.verification_status === "rejected" ? "مرفوضة" : "معلقة"}</Badge>{reading.review_reason && <div className="text-destructive mt-1">{reading.review_reason}</div>}</div></div>; })}</CardContent></Card>;
}

function Info({ label, children }: { label: string; children: React.ReactNode }) { return <div><div className="text-muted-foreground">{label}</div><div className="font-medium mt-1">{children}</div></div>; }
