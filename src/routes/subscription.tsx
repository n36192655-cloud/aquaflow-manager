import { createFileRoute } from "@tanstack/react-router";
import { useLicense, statusLabel, VENDOR_NAME } from "@/lib/license";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Lock, Phone, Mail, ShieldCheck, Users, KeyRound, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/subscription")({
  head: () => ({ meta: [{ title: "حالة الاشتراك السحابي — ميزان" }] }),
  component: SubscriptionPage,
});

function SubscriptionPage() {
  const lic = useLicense();
  const [currentStatus, setCurrentStatus] = useState<any>("active");
  const [isAdminUnlocked, setIsAdminUnlocked] = useState(false);
  const [showActivationForm, setShowActivationForm] = useState(false);
  
  const [formTenantId, setFormTenantId] = useState("");
  const [formKey, setFormKey] = useState("");
  const [formSeats, setFormSeats] = useState(3); // 3 أجهزة افتراضياً للعميل الحالي

  // فحص حالة العميل حياً من السيرفر بمجرد فتح الشاشة
  useEffect(() => {
    lic.initIfNeeded();
    lic.validateRemote().then((status) => {
      setCurrentStatus(status);
    });
  }, []);

  function unlockAdminPanel() {
    const password = prompt("🔒 يرجى إدخال رمز المطور (Indicatorz Master Key) لفتح لوحة الصيانة والتحكم عن بعد:");
    if (password !== "indicatorz@2026") {
      toast.error("رمز المطور غير صحيح!");
      return;
    }
    setIsAdminUnlocked(true);
    toast.success("🔐 تم تفعيل صلاحيات الإدارة السحابية الموحدة");
  }

  // ميزة الإيقاف الفوري عن بعد لجميع الأجهزة الثلاثة بكبسة زر واحدة من عندك
  async function toggleRemoteBilling() {
    try {
      const nextState = !lic.billingPaid;
      const { error } = await supabase
        .from("client_licenses")
        .update({ billing_paid: nextState })
        .eq("tenant_id", lic.tenantId);

      if (error) throw error;
      
      await lic.validateRemote();
      toast.success(nextState ? "تم تنشيط رخصة العميل سحابياً" : "🛑 تم تعطيل وإيقاف النظام فوراً عن كافة الأجهزة المتصلة");
      window.location.reload();
    } catch {
      toast.error("فشل تعديل الحالة السحابية، يرجى التحقق من اتصال الإنترنت.");
    }
  }

  async function submitActivation() {
    if (!formTenantId.trim() || !formKey.trim()) {
      toast.error("خطأ: يرجى إدخال البيانات كاملة.");
      return;
    }

    const success = await lic.activateRemote(
      formTenantId.trim(),
      formKey.trim(),
      formSeats
    );

    if (success) {
      toast.success("🔥 تم تفعيل المستأجر بنظام السحابة الموحدة للأجهزة المتزامنة!");
      setShowActivationForm(false);
      setFormTenantId("");
      setFormKey("");
      window.location.reload();
    } else {
      toast.error("حدث خطأ أثناء الاتصال بالخادم وتثبيت الترخيص.");
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-background via-background to-muted text-right" dir="rtl">
      <div className="flex-1 grid place-items-center px-4 py-10">
        <div className="w-full max-w-lg space-y-4">
          <Card className="border-border shadow-xl relative overflow-hidden">
            
            <button onClick={unlockAdminPanel} className="absolute top-4 left-4 text-muted-foreground/10 hover:text-primary/40 transition-colors">
              <KeyRound className="w-4 h-4" />
            </button>

            <CardHeader className="text-center">
              <div className="mx-auto w-14 h-14 rounded-2xl grid place-items-center mb-2 bg-primary/10">
                <Lock className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="text-2xl font-bold">تزامن تراخيص الأجهزة</CardTitle>
              <p className="text-sm text-muted-foreground mt-2">
                {currentStatus === "active"
                  ? "الترخيص السحابي متصل ونشط. الأجهزة تعمل الآن بالتزامن اللحظي على نفس قاعدة البيانات الموحدة."
                  : `${statusLabel(currentStatus)}. يرجى مراجعة مركز الصيانة.`}
              </p>
            </CardHeader>
            
            <CardContent className="space-y-5">
              <div className="grid gap-1 bg-muted/30 p-4 rounded-xl border text-sm">
                <Row label="معرّف المستأجر الموحد" value={lic.tenantId || "غير مفعّل ⚠️"} />
                <Row label="مفتاح الترخيص السحابي" value={lic.licenseKey ? `•••• •••• ${lic.licenseKey.slice(-4)}` : "—"} />
                <Row label="حالة الدورة الحالية" value={<Badge variant={currentStatus === "active" ? "default" : "destructive"}>{statusLabel(currentStatus)}</Badge>} />
                <Row label="تاريخ انتهاء الصلاحية" value={lic.expiresAt ? new Date(lic.expiresAt).toLocaleDateString("ar-YE") : "—"} />
                <Row label="الأجهزة المصرح بها (المقاعد)" value={<span className="flex items-center gap-1 font-mono"><Users className="w-3.5 h-3.5 text-muted-foreground" /> {lic.maxSeats} أجهزة بالتزامن</span>} />
                <Row label="بصمة جهازك الحالي" value={lic.currentFingerprint()} mono />
              </div>

              <div className="rounded-xl bg-primary/5 p-4 text-xs border border-primary/10 space-y-2.5">
                <div className="font-bold flex items-center gap-1.5 text-primary text-sm">
                  <ShieldCheck className="w-4 h-4" /> خدمات عزل البيانات والتحكم السحابي الموحد — {VENDOR_NAME}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-muted-foreground pt-1">
                  <div className="flex items-center gap-2"><Phone className="w-4 h-4 text-primary" /> +967 777 543 819</div>
                  <div className="flex items-center gap-2"><Mail className="w-4 h-4 text-primary" /> support@indicators-ye.com</div>
                </div>
              </div>

              {isAdminUnlocked && (
                <div className="border-t pt-4 space-y-4 bg-amber-500/5 p-4 rounded-xl border-dashed border-amber-500/30">
                  <div className="text-xs font-bold text-amber-700 flex items-center gap-1.5">
                    <KeyRound className="w-4 h-4" /> لوحة التحكم الفوري بالأجهزة عن بُعد (Indicatorz Suite)
                  </div>
                  
                  <div className="flex gap-2 flex-wrap">
                    <Button size="sm" variant={showActivationForm ? "default" : "outline"} onClick={() => setShowActivationForm(!showActivationForm)}>
                      {showActivationForm ? "إغلاق نموذج التفعيل" : "🚀 إنشاء رخصة سحابية لعميل"}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={toggleRemoteBilling}>
                      {lic.billingPaid ? "🛑 إيقاف الـ 3 أجهزة فوراً عن بُعد" : "✅ إعادة تشغيل الأجهزة"}
                    </Button>
                  </div>

                  {showActivationForm && (
                    <div className="bg-background p-4 rounded-lg border space-y-3 shadow-inner">
                      <div className="font-bold text-xs text-primary flex items-center gap-1 border-b pb-1">
                        <CheckCircle className="w-3.5 h-3.5" /> تهيئة العميل السحابي المتزامن
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px] font-medium text-muted-foreground">معرّف المستأجر الموحد للثلاثة أجهزة</Label>
                        <Input value={formTenantId} onChange={(e) => setFormTenantId(e.target.value)} placeholder="مثال: client-mohammad-2026" className="h-9 text-left font-mono" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px] font-medium text-muted-foreground">مفتاح ترخيص النظام الموحد</Label>
                        <Input value={formKey} onChange={(e) => setFormKey(e.target.value)} placeholder="مثال: KEY-3DEVICES-VALID" className="h-9 text-left font-mono" />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px] font-medium text-muted-foreground">عدد الأجهزة المشتركة في المزامنة</Label>
                        <Input type="number" value={formSeats} onChange={(e) => setFormSeats(Number(e.target.value))} className="h-9 text-left font-mono" />
                      </div>
                      <Button size="sm" className="w-full h-9 mt-2 font-medium" onClick={submitActivation}>ربط وتفعيل الأجهزة الثلاثة سحابياً</Button>
                    </div>
                  )}
                </div>
              )}

            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

interface RowProps { label: string; value: React.ReactNode; mono?: boolean; }
function Row({ label, value, mono }: RowProps) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/40 py-2 last:border-0 last:pb-0">
      <span className="text-muted-foreground font-medium">{label}</span>
      <span className={mono ? "font-mono text-xs text-left text-foreground bg-muted px-1.5 py-0.5 rounded" : "font-semibold text-foreground"}>{value}</span>
    </div>
  );
}
