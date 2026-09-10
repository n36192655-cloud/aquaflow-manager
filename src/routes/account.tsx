import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { toast } from "sonner";

export const Route = createFileRoute("/account")({ head: () => ({ meta: [{ title: "حسابي — منصة ميزان" }] }), component: AccountPage });

function AccountPage() {
  const { user, changePassword } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (password.length < 8) return toast.error("كلمة المرور يجب أن تكون 8 أحرف على الأقل");
    if (password !== confirm) return toast.error("تأكيد كلمة المرور غير مطابق");
    setBusy(true);
    try {
      const ok = await changePassword(password);
      if (!ok) return toast.error("تعذر تغيير كلمة المرور");
      setPassword(""); setConfirm("");
      toast.success("تم تغيير كلمة المرور بنجاح");
    } finally { setBusy(false); }
  }

  return <div className="max-w-xl mx-auto space-y-6">
    <div><h1 className="text-2xl font-bold">حسابي</h1><p className="text-sm text-muted-foreground mt-1">إدارة بيانات الدخول الشخصية — منصة ميزان لإستدامة خدمات المياه</p></div>
    <Card><CardHeader><CardTitle>بيانات الحساب</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><div><span className="text-muted-foreground">اسم المستخدم: </span><strong>{user?.username ?? "غير مُعيّن"}</strong></div><div><span className="text-muted-foreground">الدور: </span><strong>{user?.role === "admin" ? "مدير مشروع" : user?.role === "cashier" ? "محصل" : "قارئ عدادات"}</strong></div></CardContent></Card>
    <Card><CardHeader><CardTitle>تغيير كلمة المرور</CardTitle></CardHeader><CardContent className="space-y-4"><div><Label>كلمة المرور الجديدة</Label><Input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></div><div><Label>تأكيد كلمة المرور</Label><Input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void submit(); }} /></div><p className="text-xs text-muted-foreground">لا تُخزن منصة ميزان كلمة المرور في قاعدة بياناتها؛ Supabase Auth هو المسؤول عن credential.</p><Button onClick={() => void submit()} disabled={busy || !password || !confirm}>{busy ? "جارٍ الحفظ…" : "تغيير كلمة المرور"}</Button></CardContent></Card>
  </div>;
}
