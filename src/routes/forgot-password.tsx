import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestPasswordReset } from "@/lib/account.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({ meta: [{ title: "استعادة كلمة المرور — منصة ميزان" }] }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit() {
    if (!username.trim()) return toast.error("أدخل اسم المستخدم");
    setBusy(true);
    try {
      await requestPasswordReset({ data: { username } });
      setSent(true);
    } catch {
      // Deliberately generic: do not reveal whether an account exists.
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  return <div className="min-h-screen grid place-items-center px-4 bg-background" dir="rtl">
    <Card className="w-full max-w-md">
      <CardHeader><CardTitle>استعادة كلمة المرور</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">أدخل اسم المستخدم. إذا كان للحساب بريد استرداد موثّق، سيصل إليه رابط إعادة التعيين.</p>
        <div><Label htmlFor="username">اسم المستخدم</Label><Input id="username" dir="ltr" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} /></div>
        <Button className="w-full" onClick={() => void submit()} disabled={busy || !username.trim()}>{busy ? "جارٍ الإرسال…" : "إرسال رابط الاستعادة"}</Button>
        {sent && <p className="text-sm text-muted-foreground rounded-md border p-3">إذا كان الحساب مؤهلاً للاستعادة، ستصلك رسالة على بريد الاسترداد المسجّل. لا تكشف المنصة ما إذا كان اسم المستخدم موجوداً.</p>}
        <Link to="/login" className="block text-center text-sm underline">العودة لتسجيل الدخول</Link>
      </CardContent>
    </Card>
  </div>;
}
