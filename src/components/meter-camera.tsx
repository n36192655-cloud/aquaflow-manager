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
  confidence: number;
}

interface Props { open: boolean; onClose: () => void; onCapture: (res: OcrResult) => void; expectedSerial?: string | null; }
function normalize(s: string): string { return s.toUpperCase().replace(/[^A-Z0-9]/g, ""); }

function parseReading(raw: string): number | null {
  // Preserve a decimal separator when OCR sees one. Never infer decimal places from colour.
  const cleaned = raw.replace(/[٬،]/g, ",").replace(/[^0-9.,]/g, " ");
  const candidates = cleaned.match(/\d+(?:[.,]\d+)?/g) ?? [];
  if (!candidates.length) return null;
  const candidate = candidates.sort((a, b) => b.replace(/\D/g, "").length - a.replace(/\D/g, "").length)[0];
  const normalized = candidate.replace(/,/g, ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

async function recognizeImage(image: HTMLCanvasElement | HTMLImageElement): Promise<{ raw: string; reading: number | null; serial: string | null; confidence: number }> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1);
  try {
    await worker.setParameters({ tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-.," });
    const { data } = await worker.recognize(image);
    const raw = (data.text || "").trim();
    const serial = raw.match(/[A-Z]{0,3}-?\d{3,10}/i)?.[0]?.toUpperCase() ?? null;
    return { raw, reading: parseReading(raw), serial, confidence: typeof data.confidence === "number" ? Math.max(0, Math.min(1, data.confidence / 100)) : 0 };
  } finally { await worker.terminate(); }
}

export function MeterCamera({ open, onClose, onCapture, expectedSerial }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null); const canvasRef = useRef<HTMLCanvasElement | null>(null); const fileRef = useRef<HTMLInputElement | null>(null); const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false); const [progress, setProgress] = useState(0);

  useEffect(() => { if (!open) return; let cancelled = false; (async () => { try {
    if (!navigator.mediaDevices?.getUserMedia) { toast.error("الكاميرا غير مدعومة في هذا المتصفح"); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
    streamRef.current = stream; if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); setReady(true); }
  } catch { toast.error("تعذّر فتح الكاميرا. يمكنك اختيار صورة من الهاتف بدلاً منها."); } })();
  return () => { cancelled = true; setReady(false); setBusy(false); setProgress(0); streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };
  }, [open]);

  async function processCanvas(c: HTMLCanvasElement) {
    setBusy(true); setProgress(10);
    try {
      // Mild grayscale/contrast preprocessing improves digital displays without destroying red fractional registers.
      const ctx = c.getContext("2d"); if (!ctx) throw new Error("no ctx");
      const image = ctx.getImageData(0, 0, c.width, c.height); for (let i = 0; i < image.data.length; i += 4) { const y = 0.299*image.data[i] + 0.587*image.data[i+1] + 0.114*image.data[i+2]; image.data[i]=y; image.data[i+1]=y; image.data[i+2]=y; } ctx.putImageData(image,0,0);
      setProgress(35); const result = await recognizeImage(c); setProgress(90);
      let match: OcrResult["serialMatch"] = "unknown"; if (expectedSerial && result.serial) match = normalize(result.serial) === normalize(expectedSerial) ? "match" : "mismatch";
      onCapture({ ...result, imageData: c.toDataURL("image/jpeg", 0.82), serialMatch: match });
      if (result.confidence < 0.70 || result.reading == null) toast.warning("الثقة في القراءة غير كافية. راجع الصورة وأدخل القراءة يدوياً إذا لزم؛ النظام لا يخمّن.");
    } catch (e) { console.error(e); toast.error("فشل التعرف على الصورة"); } finally { setBusy(false); setProgress(100); }
  }

  async function capture() { if (!videoRef.current || !canvasRef.current) return; const v=videoRef.current,c=canvasRef.current; c.width=v.videoWidth||1280;c.height=v.videoHeight||720; const ctx=c.getContext("2d"); if(!ctx) return; ctx.drawImage(v,0,0,c.width,c.height); await processCanvas(c); }

  async function choosePhoneImage(file?: File) {
    if (!file || !file.type.startsWith("image/")) return; setBusy(true); setProgress(10);
    try { const url=URL.createObjectURL(file); const img=new Image(); img.onload=async()=>{ const c=document.createElement("canvas"); c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext("2d")?.drawImage(img,0,0); URL.revokeObjectURL(url); await processCanvas(c); }; img.src=url; } catch { setBusy(false); toast.error("تعذر قراءة صورة الهاتف"); }
  }

  return <Dialog open={open} onOpenChange={(v)=>!v&&onClose()}><DialogContent className="max-w-lg"><DialogHeader><DialogTitle className="flex items-center gap-2"><Camera className="w-4 h-4" /> تصوير العداد + التحقق البصري</DialogTitle></DialogHeader>
    {expectedSerial && <div className="text-xs bg-muted/40 border rounded-md p-2 flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-primary" /><span>الرقم المتوقع للعداد: <span className="font-mono font-semibold" dir="ltr">{expectedSerial}</span></span></div>}
    <div className="relative rounded-lg overflow-hidden bg-black aspect-video"><video ref={videoRef} playsInline muted className="w-full h-full object-cover" /><canvas ref={canvasRef} className="hidden" /><div className="absolute inset-x-8 top-1/2 -translate-y-1/2 h-16 border-2 border-yellow-400/80 rounded-md pointer-events-none" />{busy&&<div className="absolute inset-0 grid place-items-center bg-black/60 text-white text-sm"><Loader2 className="w-6 h-6 animate-spin" /><div>جارٍ تحليل الصورة… {progress}%</div></div>}</div>
    <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e)=>void choosePhoneImage(e.target.files?.[0])} />
    <p className="text-xs text-muted-foreground">يدعم الكاميرا المباشرة أو صورة ملتقطة مسبقاً من الهاتف. للعدادات الميكانيكية/الدائرية أو الصورة منخفضة الثقة، تتم مراجعة القراءة يدوياً بدلاً من التخمين.</p>
    <DialogFooter className="gap-2"><Button variant="outline" onClick={onClose} disabled={busy}><X className="w-4 h-4 ms-1" /> إلغاء</Button><Button variant="outline" onClick={()=>fileRef.current?.click()} disabled={busy}><ImagePlus className="w-4 h-4 ms-1" /> صورة من الهاتف</Button><Button onClick={()=>void capture()} disabled={!ready||busy}><ScanLine className="w-4 h-4 ms-1" /> التقاط وقراءة</Button></DialogFooter>
  </DialogContent></Dialog>;
}
