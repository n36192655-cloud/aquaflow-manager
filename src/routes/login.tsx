import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth, ROLE_LABEL, defaultRouteFor } from "@/lib/auth";
import { useLicense, statusLabel } from "@/lib/license";
import { CopyrightFooter } from "@/components/footer";
import { Droplets } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({ head: () => ({ meta: [{ title: "تسجيل الدخول — ميزان" }] }), component: LoginPage });

function LoginPage() {
  const navigate = useNavigate(); const { user, login } = useAuth(); const lic = useLicense(); const [mounted, setMounted] = useState(false); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const licStatus = mounted ? lic.validate() : "active";
  useEffect(() => { if (user) navigate({ to: defaultRouteFor(user.role), replace: true }); }, [user, navigate]);
  return <div className="min-h-screen flex flex-col bg-gradient-to-br from-background via-background to-muted"><div className="flex-1 grid place-items-center px-4 py-10"><Card className="w-full max-w-md shadow-xl"><CardHeader className="text-center"><div className="mx-auto w-14 h-14 rounded-2xl grid place-items-center mb-2 bg-water"><Droplets className="w-7 h-7" /></div><CardTitle className="text-2xl">منصة ميزان لإستدامة خدمات المياه</CardTitle><p className="text-xs text-muted-foreground mt-1">مشروع مياه المسراخ</p></CardHeader><CardContent className="space-y-4"><div><Label>البريد الإلكتروني</Label><Input dir="ltr" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></div><div><Label>كلمة المرور</Label><Input dir="ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} /></div><p className="text-xs text-muted-foreground">يُحدد دور المستخدم وصلاحياته من Supabase/RLS، وليس من الجهاز أو اختيار المستخدم.</p><Button className="w-full" size="lg" disabled={busy || !email || !password} onClick={() => void submit()}>{busy ? "جارٍ التحقق…" : "دخول آمن"}</Button>{mounted && licStatus !== "active" && <p className="text-xs text-destructive text-center">{statusLabel(licStatus)} — تواصل مع مزوّد الخدمة</p>}</CardContent></Card></div><CopyrightFooter /></div>;
  async function submit() { setBusy(true); try { const ok = await login(email, password); if (!ok) { const err = useAuth.getState().loginError; if (err === "seat_limit") toast.error("تم بلوغ الحد الأقصى للمستخدمين المتزامنين"); else if (err === "expired") toast.error("الاشتراك منتهي"); else if (err === "invalid") toast.error("الترخيص غير صالح"); else if (err === "not_configured") toast.error("تعذر الاتصال بخدمة المصادقة"); else toast.error("بيانات الدخول غير صحيحة"); return; } const u = useAuth.getState().user; if (u) { toast.success(`مرحباً ${u.name} — ${ROLE_LABEL[u.role]}`); navigate({ to: u.isSuperAdmin ? "/super-admin" : defaultRouteFor(u.role), replace: true }); } } finally { setBusy(false); } }
}
