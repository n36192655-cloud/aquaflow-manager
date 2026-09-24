import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { completeOwnerPasswordRecovery } from "@/lib/account.functions";

export const Route = createFileRoute("/admin-recovery")({
  head: () => ({
    meta: [
      { title: "استرداد حساب مالك المنصة — ميزان" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: OwnerRecoveryPage,
});

function OwnerRecoveryPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const token = useMemo(() => {
    if (typeof window === "undefined") return "";
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    return params.get("token") ?? "";
  }, []);

  async function submit() {
    if (!token) return toast.error("رابط الاسترداد غير صالح أو ناقص");
    if (password.length < 16)
      return toast.error("كلمة المرور الجديدة يجب أن تكون 16 حرفاً على الأقل");
    if (!/[A-Z]/.test(password))
      return toast.error("أضف حرفاً إنجليزياً كبيراً واحداً على الأقل");
    if (!/[a-z]/.test(password))
      return toast.error("أضف حرفاً إنجليزياً صغيراً واحداً على الأقل");
    if (!/[0-9]/.test(password))
      return toast.error("أضف رقماً واحداً على الأقل");
    if (!/[^A-Za-z0-9]/.test(password))
      return toast.error("أضف رمزاً خاصاً واحداً على الأقل");
    if (password !== confirm) return toast.error("تأكيد كلمة المرور غير مطابق");

    setBusy(true);
    try {
      await completeOwnerPasswordRecovery({ data: { token, password } });
      window.history.replaceState({}, "", window.location.pathname);
      toast.success("تم تغيير كلمة مرور مالك المنصة. سجّل الدخول الآن.");
      navigate({ to: "/login", replace: true });
    } catch {
      toast.error("تعذر تنفيذ الاسترداد. قد يكون الرابط منتهياً أو مستخدماً.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-background px-4" dir="rtl">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>استرداد حساب مالك المنصة</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted-foreground">
            أنشئ كلمة مرور جديدة للحساب الإداري. لا يتم عرض كلمة المرور السابقة ولا تخزينها في
            منصة ميزان.
          </p>
          <div>
            <Label>كلمة المرور الجديدة</Label>
            <Input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <Label>تأكيد كلمة المرور</Label>
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            المتطلبات: 16 حرفاً على الأقل، مع حرف كبير وحرف صغير ورقم ورمز خاص.
          </p>
          <Button onClick={() => void submit()} disabled={busy || !password || !confirm || !token}>
            {busy ? "جارٍ تنفيذ الاسترداد…" : "تعيين كلمة المرور الجديدة"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
