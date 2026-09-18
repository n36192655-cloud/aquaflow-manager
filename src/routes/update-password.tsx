import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export const Route = createFileRoute("/update-password")({
  head: () => ({ meta: [{ title: "تعيين كلمة مرور جديدة — منصة ميزان" }] }),
  component: UpdatePasswordPage,
});

function UpdatePasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
    });
    void supabase.auth.getSession().then(({ data: sessionData }) => {
      if (sessionData.session) setRecovery(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  async function submit() {
    if (!recovery) return toast.error("افتح رابط الاستعادة المرسل إلى بريدك");
    if (password.length < 12) return toast.error("كلمة المرور يجب أن تكون 12 حرفاً على الأقل");
    if (password !== confirm) return toast.error("تأكيد كلمة المرور غير مطابق");
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) return toast.error("تعذر تحديث كلمة المرور");
      await supabase.auth.signOut({ scope: "local" });
      toast.success("تم تحديث كلمة المرور. يمكنك تسجيل الدخول الآن.");
      navigate({ to: "/login", replace: true });
    } finally {
      setBusy(false);
    }
  }

  return <div className="min-h-screen grid place-items-center px-4 bg-background" dir="rtl">
    <Card className="w-full max-w-md">
      <CardHeader><CardTitle>تعيين كلمة مرور جديدة</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">استخدم هذه الصفحة فقط بعد فتح رابط الاستعادة من بريدك.</p>
        <div><Label>كلمة المرور الجديدة</Label><Input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></div>
        <div><Label>تأكيد كلمة المرور</Label><Input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></div>
        <Button className="w-full" onClick={() => void submit()} disabled={busy || !password || !confirm}>{busy ? "جارٍ التحديث…" : "تحديث كلمة المرور"}</Button>
      </CardContent>
    </Card>
  </div>;
}
