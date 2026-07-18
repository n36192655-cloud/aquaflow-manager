import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useStore } from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, Camera, MapPin, ShieldAlert, Check, X, Image as ImageIcon, WifiOff } from "lucide-react";
import { priceFor, fmtYER } from "@/lib/pricing";
import { MeterCamera, type OcrResult } from "@/components/meter-camera";
import { useOnlineStatus, addPending } from "@/lib/sync";
import { useAuth } from "@/lib/auth";
import { SubscriberSearch } from "@/components/subscriber-search";
import { getGeoFix, type GeoFix } from "@/lib/geolocation";

export const Route = createFileRoute("/readings")({
  head: () => ({ meta: [{ title: "القراءات — ميزان" }] }),
  component: ReadingsPage,
});

function ReadingsPage() {
  const { meters, readings, customers, bills, addReadingWithBill, approveReading, rejectReading } = useStore();
  const { user } = useAuth();
  const isReader = user?.role === "reader";
  const online = useOnlineStatus();
  const [meterId, setMeterId] = useState<number | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [photo, setPhoto] = useState<string | undefined>(undefined);
  const [ocrSerial, setOcrSerial] = useState<string | undefined>(undefined);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geo, setGeo] = useState<GeoFix | null>(null);
  const [tab, setTab] = useState<"input" | "pending" | "log" | "offline_cache">("input");

  const selected = meterId ? meters.find((m) => m.id === meterId) : null;
  const last = selected ? readings.filter((r) => r.meter_id === selected.id).sort((a, b) => +new Date(b.date) - +new Date(a.date))[0] : null;
  const selectedCustomer = selected ? customers.find((c) => c.id === selected.customer_id) : null;

  const pending = useMemo(
    () => readings.filter((r) => r.status === "pending").sort((a, b) => +new Date(b.date) - +new Date(a.date)),
    [readings],
  );

  function nameParts(name?: string) {
    const parts = (name ?? "").split(/\s+/).filter(Boolean);
    return { first: parts[0] ?? "", second: parts[1] ?? "" };
  }

  function handleOcr(res: OcrResult) {
    setCameraOpen(false);
    setPhoto(res.imageData);
    setOcrSerial(res.serial ?? undefined);
    if (res.reading != null) setCurrent(String(res.reading));

    if (res.serialMatch === "mismatch") {
      toast.error(`عدم تطابق: العداد الملتقط ${res.serial} لا يطابق العداد المسجل ${selected?.number}`);
      return;
    }
    if (res.serialMatch === "match") toast.success(`تطابق ✓ رقم العداد ${res.serial}`);
    else if (res.reading != null) toast.info(`تم التقاط قراءة ${res.reading} — رقم العداد غير مقروء بوضوح`);
  }

  async function captureGeo() {
    setGeoBusy(true);
    try {
      const fix = await getGeoFix();
      setGeo(fix);
      toast.success(`تم تحديد الموقع (${fix.accuracy.toFixed(0)} م)`);
      return fix;
    } catch (e) {
      toast.error(`فشل تحديد الموقع: ${(e as Error).message}`);
      return null;
    } finally {
      setGeoBusy(false);
    }
  }

  async function saveReading() {
    if (!selected || current === "") return toast.error("اختر مشتركاً وأدخل القراءة");
    
    // التحقق من تطابق الـ OCR برمجياً لحماية المنظومة
    if (ocrSerial && ocrSerial.replace(/[-\s]/g, "").toUpperCase() !== selected.number.replace(/[-\s]/g, "").toUpperCase()) {
      return toast.error(`رفض: رقم العداد الملتقط (${ocrSerial}) لا يطابق المسجل (${selected.number})`);
    }

    // تأمين جلب موقع الـ GPS ميدانياً عبر الهاردوير مباشرة حتى أوفلاين
    let fix = geo;
    if (!fix) {
      setGeoBusy(true);
      try {
        fix = await getGeoFix();
        setGeo(fix);
      } catch (e) {
        setGeoBusy(false);
        if (isReader) {
          return toast.error(`الموقع الجغرافي مطلوب إجبارياً للقارئ: ${(e as Error).message}`);
        }
      }
      setGeoBusy(false);
    }

    // هندسة حالة الأوفلاين: إذا لم يتوفر اتصال بالإنترنت، نقوم بحفظ الإحداثيات والصورة محلياً فوراً
    if (!online) {
      addPending({
        meterId: selected.id,
        current: +current,
        by: user?.name,
        imageData: photo,
        latitude: fix?.lat ?? 0,
        longitude: fix?.lng ?? 0
      });
      toast.warning("🔒 وضع الأوفلاين: تم حفظ القراءة محلياً مع تثبيت إحداثيات الـ GPS بنجاح. ستُزامَن تلقائياً فور توفر الشبكة.");
      resetForm();
      return;
    }

    // الحفظ المباشر أونلاين
    const { reading, bill } = addReadingWithBill({
      meterId: selected.id,
      current: +current,
      photo,
      ocrSerial,
      lat: fix?.lat,
      lng: fix?.lng,
      accuracy: fix?.accuracy,
      by: user?.name,
    });

    if (reading.flag === "error") toast.error("قراءة خاطئة: أقل من السابقة");
    else if (reading.flag === "suspicious") toast.warning("قراءة مشبوهة (تفوق 3× المتوسط) — أُرسلت للاعتماد");
    else if (bill) toast.success(`تم — استهلاك ${reading.consumption} • فاتورة ${bill.serial} بانتظار الاعتماد`);
    else toast.success(`تم — استهلاك ${reading.consumption}`);
    resetForm();
  }

  function resetForm() {
    setCurrent("");
    setPhoto(undefined);
    setOcrSerial(undefined);
    setGeo(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">القراءات</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isReader ? "ابحث عن المشترك، صوّر العداد، وسجّل القراءة" : "إدخال قراءات جديدة ومراجعتها قبل الاعتماد"}
          </p>
        </div>
        {!online && (
          <Badge variant="destructive" className="animate-pulse gap-1 text-xs">
            <WifiOff className="w-3 h-3" /> بدون إنترنت (أوفلاين)
          </Badge>
        )}
      </div>

      <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant={tab === "input" ? "default" : "outline"} onClick={() => setTab("input")}>إدخال</Button>
        {!isReader && (
          <>
            <Button size="sm" variant={tab === "pending" ? "default" : "outline"} onClick={() => setTab("pending")}>
              بانتظار الاعتماد {pending.length > 0 && <Badge className="ms-1" variant="secondary">{pending.length}</Badge>}
            </Button>
            <Button size="sm" variant={tab === "log" ? "default" : "outline"} onClick={() => setTab("log")}>سجل الكل</Button>
          </>
        )}
      </div>

      {tab === "input" && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>تسجيل قراءة</CardTitle>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={captureGeo} disabled={geoBusy}>
                <MapPin className="w-4 h-4 ms-1" /> {geo ? "✓ موقع مسبق" : "تحديد الموقع"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setCameraOpen(true)}>
                <Camera className="w-4 h-4 ms-1" /> تصوير + OCR
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="mb-1 block">بحث عن المشترك</Label>
              <SubscriberSearch value={meterId} onChange={(id) => { setMeterId(id); setOcrSerial(undefined); }} />
            </div>

            {selected && selectedCustomer && (
              <div className="rounded-lg border p-3 bg-muted/30 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <Info label="الاسم الأول">{nameParts(selectedCustomer.name).first}</Info>
                <Info label="الاسم الثاني">{nameParts(selectedCustomer.name).second}</Info>
                <Info label="رقم العداد"><span className="font-mono" dir="ltr">{selected.number}</span></Info>
                <Info label="القراءة السابقة"><span className="font-mono">{last?.current ?? 0}</span></Info>
              </div>
            )}

            <div className="grid md:grid-cols-3 gap-3 items-end">
              <div className="md:col-span-2">
                <Label>القراءة الحالية</Label>
                <Input type="number" value={current} onChange={(e) => setCurrent(e.target.value)} />
                {selected && current !== "" && +current > (last?.current ?? 0) && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    الاستهلاك المتوقع: {+current - (last?.current ?? 0)} — {fmtYER(priceFor(selected.type, +current - (last?.current ?? 0)))}
                  </p>
                )}
              </div>
              <Button onClick={saveReading} size="lg" disabled={geoBusy}>
                {geoBusy ? "جاري التقاط الإحداثيات..." : "حفظ القراءة"}
              </Button>
            </div>

            {(photo || ocrSerial || geo) && (
              <div className="flex flex-wrap gap-2 text-xs">
                {photo && <Badge variant="outline" className="gap-1"><ImageIcon className="w-3 h-3" /> صورة ملتقطة</Badge>}
                {ocrSerial && (
                  <Badge variant={selected && ocrSerial.replace(/[-\s]/g, "").toUpperCase() === selected.number.replace(/[-\s]/g, "").toUpperCase() ? "default" : "destructive"} className="gap-1">
                    <ShieldAlert className="w-3 h-3" /> OCR: {ocrSerial}
                  </Badge>
                )}
                {geo && <Badge variant="outline" className="gap-1"><MapPin className="w-3 h-3" /> {geo.lat.toFixed(4)}, {geo.lng.toFixed(4)}</Badge>}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <MeterCamera
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={handleOcr}
        expectedSerial={selected?.number ?? null}
      />

      {tab === "pending" && !isReader && (
        <Card>
          <CardHeader><CardTitle>قراءات بانتظار الاعتماد ({pending.length})</CardTitle></CardHeader>
          <CardContent className="p-4 space-y-3">
            {pending.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">لا يوجد قراءات معلقة</p>}
            {pending.map((r) => {
              const m = meters.find((x) => x.id === r.meter_id);
              const c = customers.find((x) => x.id === m?.customer_id);
              const b = bills.find((x) => x.reading_id === r.id);
              return (
                <div key={r.id} className="rounded-lg border p-3 grid md:grid-cols-[110px_1fr_auto] gap-3 items-start">
                  {r.photo ? (
                    <img src={r.photo} alt="عداد" className="w-full h-24 object-cover rounded-md border" />
                  ) : (
                    <div className="w-full h-24 rounded-md border grid place-items-center bg-muted/30 text-muted-foreground">
                      <ImageIcon className="w-5 h-5" />
                    </div>
                  )}
                  <div className="text-xs space-y-1">
                    <div className="flex items-center gap-2 text-sm font-semibold">{c?.name} — <span className="font-mono">{m?.number}</span></div>
                    <div className="text-muted-foreground">قراءة {r.previous} → <span className="text-foreground font-mono">{r.current}</span> · استهلاك {r.consumption}</div>
                    {b && <div>الفاتورة: <span className="font-mono">{b.serial}</span> · {fmtYER(b.total)} {b.arrears > 0 && <span className="text-destructive">(متأخرات {fmtYER(b.arrears)})</span>}</div>}
                    <div className="flex gap-2 flex-wrap text-[11px] text-muted-foreground">
                      {r.ocr_serial && <span>OCR: <span className="font-mono">{r.ocr_serial}</span></span>}
                      {r.lat != null && r.lng != null && (
                        <a className="underline hover:text-primary" href={`https://maps.google.com/?q=${r.lat},${r.lng}`} target="_blank" rel="noreferrer">
                          <MapPin className="inline w-3 h-3" /> {r.lat.toFixed(4)}, {r.lng.toFixed(4)}
                        </a>
                      )}
                      {r.by && <span>بواسطة: {r.by}</span>}
                      <span>{new Date(r.date).toLocaleString("ar")}</span>
                    </div>
                  </div>
                  <div className="flex md:flex-col gap-2">
                    <Button size="sm" onClick={() => { approveReading(r.id); toast.success("تم الاعتماد"); }}>
                      <Check className="w-3 h-3 ms-1" /> اعتماد
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => { rejectReading(r.id); toast.info("تم الرفض"); }}>
                      <X className="w-3 h-3 ms-1" /> رفض
                    </Button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {tab === "log" && !isReader && (
        <Card>
          <CardHeader><CardTitle>سجل القراءات ({readings.length})</CardTitle></CardHeader>
          <CardContent className="p-4 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">التسلسل</TableHead>
                  <TableHead className="text-right">التاريخ</TableHead>
                  <TableHead className="text-right">العداد</TableHead>
                  <TableHead className="text-right">المشترك</TableHead>
                  <TableHead className="text-right">السابقة</TableHead>
                  <TableHead className="text-right">الحالية</TableHead>
                  <TableHead className="text-right">الاستهلاك</TableHead>
                  <TableHead className="text-right">الحالة</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...readings].sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 200).map((r) => {
                  const m = meters.find((x) => x.id === r.meter_id);
                  const c = customers.find((x) => x.id === m?.customer_id);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-[11px]">{r.serial}</TableCell>
                      <TableCell className="text-xs">{new Date(r.date).toLocaleDateString("ar-EG")}</TableCell>
                      <TableCell className="font-mono">{m?.number}</TableCell>
                      <TableCell>{c?.name}</TableCell>
                      <TableCell>{r.previous}</TableCell>
                      <TableCell>{r.current}</TableCell>
                      <TableCell className="font-semibold">{r.consumption}</TableCell>
                      <TableCell>
                        {r.status === "pending" ? (
                          <Badge variant="secondary">معلقة</Badge>
                        ) : r.status === "rejected" ? (
                          <Badge variant="destructive"><X className="w-3 h-3 ms-1" /> مرفوضة</Badge>
                        ) : r.flag === "ok" ? (
                          <Badge variant="outline" className="gap-1 text-water"><CheckCircle2 className="w-3 h-3" /> معتمدة</Badge>
                        ) : r.flag === "suspicious" ? (
                          <Badge variant="secondary" className="gap-1"><AlertCircle className="w-3 h-3" /> مشبوهة</Badge>
                        ) : (
                          <Badge variant="destructive" className="gap-1"><AlertCircle className="w-3 h-3" /> خاطئة</Badge>
                        )
                        }
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-muted-foreground text-[10px]">{label}</div>
      <div className="text-sm font-medium mt-0.5">{children}</div>
    </div>
  );
}
