import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth, type Role, ROLE_LABEL, defaultRouteFor } from "@/lib/auth";
import { useLicense, statusLabel } from "@/lib/license";
import { CopyrightFooter } from "@/components/footer";
import { Droplets, ShieldCheck, Camera, Wallet } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "تسجيل الدخول — ميزان" }] }),
  component: LoginPage,
});

const ROLES: { value: Role; icon: typeof ShieldCheck; desc: string }[] = [
  { value: "admin", icon: ShieldCheck, desc: "لوحة التحكم والإحصائيات والمساعد الذكي" },
  { value: "reader", icon: Camera, desc: "تصوير العدادات وإدخال القراءات ميدانياً" },
  { value: "cashier", icon: Wallet, desc: "استلام الدفعات النقدية وإصدار السندات" },
];

function LoginPage() {
  const navigate = useNavigate();
  const { user, login } = useAuth();
  const lic = useLicense();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const licStatus = mounted ? lic.validate() : "active";
  const [role, setRole] = useState<Role>("admin");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (user) navigate({ to: defaultRouteFor(user.role), replace: true });
  }, [user, navigate]);

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-background via-background to-muted">
      <div className="flex-1 grid place-items-center px-4 py-10">
        <Card className="w-full max-w-md shadow-xl">
          <CardHeader className="text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl grid place-items-center mb-2" style={{ background: "linear-gradient(135deg, var(--water) 0%, #0ea5e9 100%)" }}>
              <Droplets className="w-7 h-7 text-white" />
            </div>
            <CardTitle className="text-2xl">منصة ميزان</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">إدارة مشاريع المياه — تعز، اليمن</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="mb-2 block">اختر الدور</Label>
              <div className="grid gap-2">
                {ROLES.map((r) => {
                  const Icon = r.icon;
                  const active = role === r.value;
                  return (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => setRole(r.value)}
                      className={`text-right p-3 rounded-lg border transition-colors flex items-start gap-3 ${
                        active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <Icon className={`w-5 h-5 mt-0.5 ${active ? "text-primary" : "text-muted-foreground"}`} />
                      <div>
                        <div className="font-semibold text-sm">{ROLE_LABEL[r.value]}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{r.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <Label>الاسم</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="أدخل اسمك" />
            </div>
            <div>
              <Label>كلمة المرور</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="1234 (تجريبية)" />
              <p className="text-[10px] text-muted-foreground mt-1">النظام يعمل بدون إنترنت — كلمة المرور التجريبية: 1234</p>
            </div>

            <Button className="w-full" size="lg" onClick={() => {
              const ok = login(name, role, password);
              if (!ok) {
                const err = (useAuth.getState() as { loginError: string | null }).loginError;
                if (err === "seat_limit") return toast.error("تم بلوغ الحد الأقصى للمستخدمين المتزامنين لهذه المؤسسة");
                if (err === "expired") return toast.error("الاشتراك منتهي — يرجى تجديد الترخيص");
                if (err === "invalid") return toast.error("الترخيص غير صالح على هذا الجهاز/النطاق");
                return toast.error("بيانات غير صحيحة");
              }
              toast.success(`مرحباً ${name} — ${ROLE_LABEL[role]}`);
              navigate({ to: defaultRouteFor(role), replace: true });
            }}>
              دخول
            </Button>
            {mounted && licStatus !== "active" && (
              <p className="text-xs text-destructive text-center">{statusLabel(licStatus)} — تواصل مع مزوّد الخدمة</p>
            )}
            {mounted && lic.tenantId && (
              <p className="text-[10px] text-muted-foreground text-center">مؤسسة #{lic.tenantId} · مقاعد {lic.seats.length}/{lic.maxSeats}</p>
            )}
          </CardContent>
        </Card>
      </div>
      <CopyrightFooter />
    </div>
  );
}