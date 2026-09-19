import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";

export const Route = createFileRoute("/account")({ head: () => ({ meta: [{ title: "حسابي — منصة ميزان" }] }), component: AccountPage });

function AccountPage() {
  const navigate = useNavigate();
  const { user, changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);

  useEffect(() => { void supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? "")); }, []);

  async function updateRecoveryEmail() {
    const next = email.trim().toLowerCase();
    if (!next || next.endsWith("@mizan.local") || !next.includes("@")) return toast.error("أدخل بريداً إلكترونياً حقيقياً للاسترداد");
    setEmailBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ email: next });
      if (error) return toast.error("تعذر تحديث بريد الاسترداد");
      toast.success("تم إرسال رسالة تأكيد إلى البريد الجديد. لن تعمل الاستعادة حتى تأكيد البريد.");
    } finally { setEmailBusy(false); }
  }

  async function submit() {
    if (!currentPassword) return toast.error("أدخل كلمة المرور الحالية للتحقق من هويتك");
    if (password.length < 12) return toast.error("كلمة المرور يجب أن تكون 12 حرفاً على الأقل");
    if (password !== confirm) return toast.error("تأكيد كلمة المرور غير مطابق");
    setBusy(true);
    try {
      const ok = await changePassword(currentPassword, password);
      if (!ok) return toast.error("تعذر تغيير كلمة المرور");
      setCurrentPassword(""); setPassword(""); setConfirm("");
      toast.success("تم تغيير كلمة المرور بنجاح. تم تسجيل الخروج من الجلسات السابقة، سجّل الدخول مجدداً.");
      navigate({ to: "/login", replace: true });
    } finally { setBusy(false); }
  }

  return <div className="max-w-xl mx-auto space-y-6">
    <div><h1 className="text-2xl font-bold">حسابي</h1><p className="text-sm text-muted-foreground mt-1">إدارة بيانات الدخول الشخصية — منصة ميزان لإستدامة خدمات المياه</p></div>
    <Card><CardHeader><CardTitle>بيانات الحساب</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><div><span className="text-muted-foreground">اسم المستخدم: </span><strong>{user?.username ?? "غير مُعيّن"}</strong></div><div><span className="text-muted-foreground">الدور: </span><strong>{user?.role === "admin" ? "مدير مشروع" : user?.role === "cashier" ? "محصل" : "قارئ عدادات"}</strong></div></CardContent></Card>
    <Card><CardHeader><CardTitle>بريد الاسترداد</CardTitle></CardHeader><CardContent className="space-y-3">
      <p className="text-xs text-muted-foreground">الحسابات التي أنشأها المشرف تبدأ بمعرّف داخلي. أضف بريداً حقيقياً وفعّله حتى تستطيع استخدام «نسيت كلمة المرور» لاحقاً.</p>
      <Input type="email" autoComplete="email" dir="ltr" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />
      <Button variant="outline" onClick={() => void updateRecoveryEmail()} disabled={emailBusy || !email.trim()}>{emailBusy ? "جارٍ الحفظ…" : "حفظ بريد الاسترداد"}</Button>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>تغيير كلمة المرور</CardTitle></CardHeader><CardContent className="space-y-4"><div><Label>كلمة المرور الحالية</Label><Input type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} /></div><div><Label>كلمة المرور الجديدة</Label><Input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></div><div><Label>تأكيد كلمة المرور</Label><Input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void submit(); }} /></div><p className="text-xs text-muted-foreground">لا تُخزن منصة ميزان كلمة المرور في قاعدة بياناتها؛ Supabase Auth هو المسؤول عن credential.</p><Button onClick={() => void submit()} disabled={busy || !currentPassword || !password || !confirm}>{busy ? "جارٍ الحفظ…" : "تغيير كلمة المرور"}</Button></CardContent></Card>
  </div>;
}
