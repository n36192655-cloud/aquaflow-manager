import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Camera, Loader2, ScanLine, X, ShieldAlert, ImagePlus } from "lucide-react";
import { toast } from "sonner";

export interface OcrResult {
  reading: number | null;
  serial: string | null;
  raw: string;
  imageData: string;
  serialMatch: "match" | "mismatch" | "unknown";
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCapture: (res: OcrResult) => void;
  expectedSerial?: string | null;
}

function normalize(s: string): string { return s.toUpperCase().replace(/[-\s]/g, ""); }

function imageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function MeterCamera({ open, onClose, onCapture, expectedSerial }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
          toast.info("استخدم زر «اختيار/تصوير من الهاتف» لأن الكاميرا المباشرة غير متاحة.");
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); setReady(true); }
      } catch (e) {
        console.warn("[Mizan] camera unavailable", e);
        toast.info("تعذّر فتح الكاميرا المباشرة؛ يمكنك التصوير أو اختيار صورة من الهاتف.");
      }
    })();
    return () => {
      cancelled = true; setReady(false); setBusy(false); setProgress(0);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open]);

  async function recognize(imageData: string) {
    setBusy(true); setProgress(0);
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng", 1, { logger: (m: { status: string; progress: number }) => { if (m.status === "recognizing text") setProgress(Math.round(m.progress * 100)); } });
      await worker.setParameters({ tessedit_char_whitelist: "0123456789.-WEabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" });
      const { data } = await worker.recognize(imageData);
      await worker.terminate();

      const raw = (data.text || "").trim();
      const serialMatch = raw.match(/[A-Z]{0,3}-?\d{3,8}/i);
      // Do not use parseInt/longest-integer heuristics for decimal meters.
      // OCR is only a candidate. The operator must confirm the actual current reading.
      const decimalCandidates = raw.match(/\d{1,8}[.,]\d{1,4}/g) ?? [];
      const integerCandidates = raw.match(/\d{2,8}/g) ?? [];
      const candidate = decimalCandidates[0] ?? integerCandidates.sort((a, b) => b.length - a.length)[0];
      const reading = candidate ? Number(candidate.replace(",", ".")) : null;
      const serial = serialMatch ? serialMatch[0].toUpperCase() : null;
      let match: OcrResult["serialMatch"] = "unknown";
      if (expectedSerial && serial) match = normalize(serial) === normalize(expectedSerial) ? "match" : "mismatch";
      onCapture({ reading: Number.isFinite(reading) ? reading : null, serial, raw, imageData, serialMatch: match });
      if (!candidate) toast.warning("لم تُستخرج قراءة رقمية موثوقة. أدخل القراءة يدويًا بعد مراجعة الصورة.");
      else toast.info(`قراءة OCR مرشحة: ${candidate.replace(",", ".")} — يجب تأكيدها حسب دقة العداد.`);
    } catch (e) {
      console.error(e);
      toast.error("فشل تحليل الصورة؛ يمكنك إدخال القراءة يدويًا.");
    } finally { setBusy(false); }
  }

  async function capture() {
    if (!videoRef.current || !canvasRef.current) return;
    const v = videoRef.current; const c = canvasRef.current;
    const w = v.videoWidth || 1280; const h = v.videoHeight || 720;
    c.width = w; c.height = h;
    const ctx = c.getContext("2d"); if (!ctx) return;
    ctx.drawImage(v, 0, 0, w, h);
    await recognize(c.toDataURL("image/jpeg", 0.86));
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.currentTarget.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return toast.error("اختر ملف صورة صالحًا.");
    if (file.size > 12 * 1024 * 1024) return toast.error("حجم الصورة كبير جدًا (الحد 12MB).");
    try { await recognize(await imageToDataUrl(file)); } catch { toast.error("تعذر قراءة الصورة من الهاتف."); }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Camera className="w-4 h-4" /> تصوير العداد والتحقق البصري</DialogTitle></DialogHeader>
        {expectedSerial && <div className="text-xs bg-muted/40 border rounded-md p-2 flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-primary" /><span>رقم العداد المسجل: <span className="font-mono font-semibold" dir="ltr">{expectedSerial}</span></span></div>}
        <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
          <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
          <canvas ref={canvasRef} className="hidden" />
          <div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-20 border-2 border-yellow-400/80 rounded-md pointer-events-none" />
          {busy && <div className="absolute inset-0 grid place-items-center bg-black/60 text-white text-sm"><div className="flex flex-col items-center gap-2"><Loader2 className="w-6 h-6 animate-spin" /><div>جارٍ تحليل الصورة… {progress}%</div></div></div>}
        </div>
        <p className="text-xs text-muted-foreground">الـOCR نتيجة مرشحة وليست حكمًا نهائيًا. لا يعتمد النظام القراءة أو دقة الكسور من لون الأرقام؛ يجب مراجعة القراءة وفق ملف العداد.</p>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFileChange} />
        <DialogFooter className="gap-2 flex-wrap">
          <Button variant="outline" onClick={onClose} disabled={busy}><X className="w-4 h-4 ms-1" /> إلغاء</Button>
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}><ImagePlus className="w-4 h-4 ms-1" /> تصوير/اختيار من الهاتف</Button>
          <Button onClick={capture} disabled={!ready || busy}><ScanLine className="w-4 h-4 ms-1" /> التقاط وتحليل</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
