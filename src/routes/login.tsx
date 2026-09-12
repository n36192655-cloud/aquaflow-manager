import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth, ROLE_LABEL, defaultRouteFor } from "@/lib/auth";
import { useLicense, statusLabel } from "@/lib/license";
import { CopyrightFooter } from "@/components/footer";
import { Droplets, Banknote, ClipboardList, UserCog } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({ head: () => ({ meta: [{ title: "تسجيل الدخول — منصة ميزان" }] }), component: LoginPage });

type LoginPreset = { label: string; username: string; icon: typeof UserCog };
const LOGIN_PRESETS: LoginPreset[] = [
  { label: "مدير المشروع", username: "manager", icon: UserCog },
  { label: "المحصل", username: "cashier", icon: Banknote },
  { label: "قارئ العدادات", username: "reader", icon: ClipboardList },
];

function LoginPage() {
  const navigate = useNavigate();
  const { user, login } = useAuth();
  const lic = useLicense();
  const [mounted, setMounted] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { setMounted(true); }, []);
  const licStatus = mounted ? lic.validate() : "active";
  useEffect(() => { if (user) navigate({ to: user.isSuperAdmin ? "/super-admin" : defaultRouteFor(user.role), replace: true }); }, [user, navigate]);

  function selectAccount(account: LoginPreset) { setUsername(account.username); setPassword(""); }

  async function submit() {
    setBusy(true);
    try {
      const ok = await login(username, password);
      if (!ok) {
        const err = useAuth.getState().loginError;
        if (err === "seat_limit") toast.error("تم بلوغ الحد الأقصى للمستخدمين المتزامنين");
        else if (err === "expired") toast.error("الاشتراك منتهي");
        else if (err === "invalid") toast.error("الترخيص غير صالح");
        else if (err === "not_configured") toast.error("تعذر الاتصال بخدمة المصادقة");
        else toast.error("اسم المستخدم أو كلمة المرور غير صحيحة");
        return;
      }
      const u = useAuth.getState().user;
      if (u) { toast.success(`مرحباً ${u.name} — ${ROLE_LABEL[u.role]}`); navigate({ to: u.isSuperAdmin ? "/super-admin" : defaultRouteFor(u.role), replace: true }); }
    } finally { setBusy(false); }
  }

  return <div className="min-h-screen flex flex-col bg-gradient-to-br from-background via-background to-muted">
    <div className="flex-1 grid place-items-center px-4 py-10"><Card className="w-full max-w-lg shadow-xl"><CardHeader className="text-center"><div className="mx-auto w-14 h-14 rounded-2xl grid place-items-center mb-2 bg-water"><Droplets className="w-7 h-7 text-white" /></div><CardTitle className="text-2xl">منصة ميزان لإستدامة خدمات المياه</CardTitle><p className="text-xs text-muted-foreground mt-1">سيظهر مشروع المياه المرتبط بالحساب بعد تسجيل الدخول</p></CardHeader>
      <CardContent className="space-y-5"><div><Label className="mb-2 block">اختر الحساب</Label><div className="grid grid-cols-1 sm:grid-cols-3 gap-2">{LOGIN_PRESETS.map((account) => { const Icon = account.icon; const selected = username === account.username; return <Button key={account.username} type="button" variant={selected ? "default" : "outline"} aria-pressed={selected} className="h-auto min-h-20 flex-col gap-1 py-3" onClick={() => selectAccount(account)}><Icon className="w-5 h-5" /><span>{account.label}</span></Button>; })}</div></div>
        <div><Label htmlFor="username">اسم المستخدم</Label><Input id="username" dir="ltr" type="text" autoComplete="username" value={username} readOnly aria-readonly="true" placeholder="اضغط على نوع الحساب أعلاه" className="bg-muted/50 font-mono" /><p className="text-xs text-muted-foreground mt-1">يُحدد تلقائياً حسب الحساب الذي اخترته.</p></div>
        <div><Label htmlFor="password">كلمة المرور</Label><Input id="password" dir="ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} placeholder="أدخل كلمة المرور" /></div>
        <p className="text-xs text-muted-foreground">الأدوار والصلاحيات تُحدد من الحساب في Supabase/RLS ولا يمكن تغييرها من شاشة الدخول.</p><Button className="w-full" size="lg" disabled={busy || !username || !password} onClick={() => void submit()}>{busy ? "جارٍ التحقق…" : "دخول آمن"}</Button>{mounted && licStatus !== "active" && <p className="text-xs text-destructive text-center">{statusLabel(licStatus)} — تواصل مع مزوّد الخدمة</p>}
      </CardContent></Card></div><CopyrightFooter /></div>;
}
