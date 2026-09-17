import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Camera, Loader2, ScanLine, X, ShieldAlert, ImagePlus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";

export interface MeterProfileForOcr {
  integerDigits: number;
  decimalDigits: number;
  registerOrder: "integer_then_decimal" | "decimal_then_integer";
}

export interface OcrResult {
  reading: number | null;
  serial: string | null;
  raw: string;
  imageData: string;
  serialMatch: "match" | "mismatch" | "unknown";
  confidence: number;
  readingCandidates: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCapture: (res: OcrResult) => void;
  expectedSerial?: string | null;
  profile?: MeterProfileForOcr | null;
}

function normalize(s: string): string { return s.toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function digitCount(value: string): number { return value.replace(/\D/g, "").length; }

function parseCandidate(candidate: string, profile?: MeterProfileForOcr | null): number | null {
  if (!profile) return null;
  const normalized = candidate.replace(/,/g, ".");
  const parts = normalized.split(".");
  if (parts.length > 2 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const digits = digitCount(normalized);
  const integerDigits = Math.max(0, profile.integerDigits || 0);
  const decimalDigits = Math.max(0, profile.decimalDigits || 0);

  if (decimalDigits === 0) {
    if (parts.length !== 1 || (integerDigits > 0 && digits !== integerDigits)) return null;
    const n = Number(parts[0]);
    return Number.isFinite(n) ? n : null;
  }

  if (parts.length === 2) {
    const left = parts[0];
    const right = parts[1];
    if (profile.registerOrder === "integer_then_decimal") {
      if ((integerDigits > 0 && left.length !== integerDigits) || right.length !== decimalDigits) return null;
      const n = Number(`${left}.${right}`);
      return Number.isFinite(n) ? n : null;
    }
    if (left.length !== decimalDigits || (integerDigits > 0 && right.length !== integerDigits)) return null;
    const n = Number(`${right}.${left}`);
    return Number.isFinite(n) ? n : null;
  }

  if (digits !== integerDigits + decimalDigits) return null;
  if (profile.registerOrder === "integer_then_decimal") {
    const split = integerDigits;
    if (split <= 0 || split >= candidate.length) return null;
    const integerPart = candidate.slice(0, split);
    const decimalPart = candidate.slice(split);
    const n = Number(`${integerPart}.${decimalPart}`);
    return Number.isFinite(n) ? n : null;
  }

  const split = decimalDigits;
  if (split <= 0 || split >= candidate.length) return null;
  const decimalPart = candidate.slice(0, split);
  const integerPart = candidate.slice(split);
  const n = Number(`${integerPart}.${decimalPart}`);
  return Number.isFinite(n) ? n : null;
}

function parseReading(raw: string, profile?: MeterProfileForOcr | null, expectedSerial?: string | null): { reading: number | null; candidates: number } {
  const cleaned = raw.replace(/[٬،]/g, ",").replace(/[^0-9.,]/g, " ");
  const tokens = cleaned.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const expected = expectedSerial ? normalize(expectedSerial) : "";
  const valid: number[] = [];

  for (const token of tokens) {
    const tokenDigits = normalize(token);
    if (expected && tokenDigits && tokenDigits === expected) continue;
    const value = parseCandidate(token, profile);
    if (value != null) valid.push(value);
  }

  const unique = [...new Set(valid)];
  return { reading: unique.length === 1 ? unique[0] : null, candidates: unique.length };
}

async function recognizeImage(image: HTMLCanvasElement | HTMLImageElement, profile?: MeterProfileForOcr | null, expectedSerial?: string | null): Promise<{ raw: string; reading: number | null; serial: string | null; confidence: number; candidates: number }> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1);
  try {
    await worker.setParameters({ tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-.," });
    const { data } = await worker.recognize(image);
    const raw = (data.text || "").trim();
    const serial = raw.match(/[A-Z]{0,3}-?\d{3,10}/i)?.[0]?.toUpperCase() ?? null;
    const parsed = parseReading(raw, profile, expectedSerial);
    return {
      raw,
      reading: parsed.reading,
      serial,
      candidates: parsed.candidates,
      confidence: typeof data.confidence === "number" ? Math.max(0, Math.min(1, data.confidence / 100)) : 0,
    };
  } finally { await worker.terminate(); }
}

export function MeterCamera({ open, onClose, onCapture, expectedSerial, profile }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [resolvedProfile, setResolvedProfile] = useState<MeterProfileForOcr | null>(profile ?? null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    setResolvedProfile(profile ?? null);
    if (!open || profile || !expectedSerial) return;
    let cancelled = false;
    (async () => {
      const { data: meter, error: meterError } = await supabase
        .from("meters")
        .select("profile_id")
        .eq("serial_number", expectedSerial)
        .maybeSingle();
      if (cancelled || meterError || !meter?.profile_id) return;
      const { data: meterProfile, error: profileError } = await supabase
        .from("meter_profiles")
        .select("integer_digits,decimal_digits,register_order")
        .eq("id", meter.profile_id)
        .maybeSingle();
      if (cancelled || profileError || !meterProfile) return;
      setResolvedProfile({
        integerDigits: Number(meterProfile.integer_digits ?? 0),
        decimalDigits: Number(meterProfile.decimal_digits ?? 0),
        registerOrder: meterProfile.register_order === "decimal_then_integer" ? "decimal_then_integer" : "integer_then_decimal",
      });
    })().catch((error) => console.error("Unable to resolve meter OCR profile", error));
    return () => { cancelled = true; };
  }, [open, expectedSerial, profile]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) { toast.error("الكاميرا غير مدعومة في هذا المتصفح"); return; }
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); setReady(true); }
      } catch { toast.error("تعذّر فتح الكاميرا. يمكنك اختيار صورة من الهاتف بدلاً منها."); }
    })();
    return () => {
      cancelled = true;
      setReady(false);
      setBusy(false);
      setProgress(0);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open]);

  async function processCanvas(c: HTMLCanvasElement) {
    setBusy(true);
    setProgress(10);
    try {
      // Keep the original colour image. Colour semantics are meter metadata, not an OCR shortcut.
      setProgress(35);
      const result = await recognizeImage(c, resolvedProfile, expectedSerial);
      setProgress(90);
      let match: OcrResult["serialMatch"] = "unknown";
      if (expectedSerial && result.serial) match = normalize(result.serial) === normalize(expectedSerial) ? "match" : "mismatch";
      onCapture({
        reading: result.reading,
        serial: result.serial,
        raw: result.raw,
        imageData: c.toDataURL("image/jpeg", 0.82),
        serialMatch: match,
        confidence: result.confidence,
        readingCandidates: result.candidates,
      });
      if (match === "mismatch") toast.error("رقم العداد الملتقط لا يطابق العداد المختار؛ راجع الصورة قبل الحفظ.");
      else if (result.candidates !== 1) toast.warning("لم يتم العثور على قراءة واحدة غير ملتبسة وفق مواصفة العداد؛ أدخل القراءة يدوياً.");
      else if (result.confidence < 0.70) toast.warning("الثقة في OCR منخفضة؛ راجع القراءة يدوياً قبل الحفظ.");
    } catch (e) {
      console.error(e);
      toast.error("فشل التعرف على الصورة");
    } finally {
      setBusy(false);
      setProgress(100);
    }
  }

  async function capture() {
    if (!videoRef.current || !canvasRef.current) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    c.width = v.videoWidth || 1280;
    c.height = v.videoHeight || 720;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    await processCanvas(c);
  }

  async function choosePhoneImage(file?: File) {
    if (!file || !file.type.startsWith("image/")) return;
    setBusy(true);
    setProgress(10);
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = async () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d")?.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        await processCanvas(c);
      };
      img.src = url;
    } catch {
      setBusy(false);
      toast.error("تعذر قراءة صورة الهاتف");
    }
  }

  return <Dialog open={open} onOpenChange={(v) => !v && onClose()}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle className="flex items-center gap-2"><Camera className="w-4 h-4" /> تصوير العداد + التحقق البصري</DialogTitle></DialogHeader>
    {expectedSerial && <div className="text-xs bg-muted/40 border rounded-md p-2 flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-primary" /><span>الرقم المتوقع للعداد: <span className="font-mono font-semibold" dir="ltr">{expectedSerial}</span></span></div>}
    {resolvedProfile && <div className="text-xs bg-muted/40 border rounded-md p-2">مواصفة القراءة: {resolvedProfile.integerDigits} أرقام صحيحة + {resolvedProfile.decimalDigits} أرقام عشرية · ترتيب السجل: {resolvedProfile.registerOrder === "integer_then_decimal" ? "صحيح ثم عشري" : "عشري ثم صحيح"}</div>}
    <div className="relative rounded-lg overflow-hidden bg-black aspect-video"><video ref={videoRef} playsInline muted className="w-full h-full object-cover" /><canvas ref={canvasRef} className="hidden" /><div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-16 border-2 border-yellow-400/80 rounded-md pointer-events-none" />{busy&&<div className="absolute inset-0 grid place-items-center bg-black/60 text-white text-sm"><Loader2 className="w-6 h-6 animate-spin" /><div>جارٍ تحليل الصورة… {progress}%</div></div>}</div>
    <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void choosePhoneImage(e.target.files?.[0])} />
    <p className="text-xs text-muted-foreground">OCR اقتراح فقط. لا يتم اعتماد القراءة تلقائياً؛ عند الغموض أو عدم مطابقة مواصفة العداد يجب مراجعتها وإدخالها يدوياً. ألوان السجل لا تُستخدم لاستنتاج الرقم.</p>
    <DialogFooter className="gap-2"><Button variant="outline" onClick={onClose} disabled={busy}><X className="w-4 h-4 ms-1" /> إلغاء</Button><Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}><ImagePlus className="w-4 h-4 ms-1" /> صورة من الهاتف</Button><Button onClick={() => void capture()} disabled={!ready || busy}><ScanLine className="w-4 h-4 ms-1" /> التقاط وقراءة</Button></DialogFooter>
  </DialogContent></Dialog>;
}
