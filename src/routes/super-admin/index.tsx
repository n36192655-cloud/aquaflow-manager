import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { ShieldCheck, RefreshCw, LogOut } from "lucide-react";

export const Route = createFileRoute("/super-admin/")({
  head: () => ({
    meta: [
      { title: "لوحة مالك المنصة — ميزان" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: SuperAdminDashboard,
});

interface TenantRow {
  id: string;
  name: string;
  subscription_status: "active" | "suspended" | "expired";
  subscription_expires_at: string | null;
  created_at: string;
}

function SuperAdminDashboard() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) {
        setAllowed(false);
        setChecking(false);
        navigate({ to: "/login" });
        return;
      }
      const { data: roles } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", uid);
      const ok = (roles ?? []).some((r) => r.role === "super_admin");
      setAllowed(ok);
      setChecking(false);
      if (!ok) {
        toast.error("هذه الصفحة مخصّصة لمالك المنصة فقط");
        navigate({ to: "/" });
        return;
      }
      void refresh();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  async function refresh() {
    setLoading(true);
    const { data, error } = await supabase
      .from("tenants")
      .select("id, name, subscription_status, subscription_expires_at, created_at")
      .order("created_at", { ascending: false });
    setLoading(false);
    if (error) {
      toast.error("تعذّر جلب قائمة المشاريع");
      return;
    }
    setTenants((data ?? []) as TenantRow[]);
  }

  async function toggleStatus(t: TenantRow) {
    const next = t.subscription_status === "active" ? "suspended" : "active";
    const { error } = await supabase
      .from("tenants")
      .update({ subscription_status: next })
      .eq("id", t.id);
    if (error) {
      toast.error("فشل تحديث الحالة");
      return;
    }
    toast.success(next === "active" ? "تم تفعيل المشروع" : "تم تعليق المشروع");
    void refresh();
  }

  async function extendExpiry(t: TenantRow, days: number) {
    const base =
      t.subscription_expires_at && new Date(t.subscription_expires_at) > new Date()
        ? new Date(t.subscription_expires_at)
        : new Date();
    base.setDate(base.getDate() + days);
    const { error } = await supabase
      .from("tenants")
      .update({ subscription_expires_at: base.toISOString() })
      .eq("id", t.id);
    if (error) {
      toast.error("فشل تمديد الاشتراك");
      return;
    }
    toast.success(`تم تمديد الاشتراك ${days} يومًا`);
    void refresh();
  }

  async function createTenant(name: string) {
    if (!name.trim()) return;
    const { error } = await supabase.from("tenants").insert({ name: name.trim() });
    if (error) {
      toast.error("تعذّر إنشاء المشروع");
      return;
    }
    toast.success("تم إنشاء مشروع جديد");
    void refresh();
  }

  if (checking) return null;
  if (!allowed) {
    return (
      <div className="min-h-screen grid place-items-center px-4" dir="rtl">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <ShieldCheck className="w-5 h-5" /> صلاحية مالك المنصة مطلوبة
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              هذه اللوحة مخصصة لمالكي منصة ميزان فقط.
            </p>
            <Button
              variant="outline"
              onClick={async () => {
                await supabase.auth.signOut();
                navigate({ to: "/login", replace: true });
              }}
            >
              <LogOut className="w-4 h-4 ml-2" /> تسجيل الخروج
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8" dir="rtl">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ShieldCheck className="w-6 h-6 text-primary" /> لوحة مالك المنصة
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              إدارة مشاريع المياه والاشتراكات
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ml-2 ${loading ? "animate-spin" : ""}`} /> تحديث
          </Button>
        </header>

        <NewTenantForm onCreate={createTenant} />

        <Card>
          <CardHeader>
            <CardTitle>مشاريع المياه ({tenants.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {tenants.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">
                لا توجد مشاريع بعد.
              </p>
            )}
            {tenants.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center gap-3 justify-between rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <div className="font-semibold truncate">{t.name}</div>
                  <div className="text-xs text-muted-foreground font-mono truncate">
                    {t.id}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    ينتهي:{" "}
                    {t.subscription_expires_at
                      ? new Date(t.subscription_expires_at).toLocaleDateString("ar-YE")
                      : "غير محدّد"}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    variant={t.subscription_status === "active" ? "default" : "destructive"}
                  >
                    {t.subscription_status === "active"
                      ? "نشط"
                      : t.subscription_status === "suspended"
                        ? "موقوف"
                        : "منتهي"}
                  </Badge>
                  <Button size="sm" variant="outline" onClick={() => toggleStatus(t)}>
                    {t.subscription_status === "active" ? "تعليق" : "تفعيل"}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => extendExpiry(t, 30)}>
                    +30 يوم
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => extendExpiry(t, 365)}>
                    +سنة
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function NewTenantForm({ onCreate }: { onCreate: (name: string) => Promise<void> | void }) {
  const [name, setName] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle>إنشاء مشروع مياه جديد</CardTitle>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="اسم مشروع المياه (مثال: مياه تعز)"
        />
        <Button
          onClick={async () => {
            await onCreate(name);
            setName("");
          }}
        >
          إنشاء
        </Button>
      </CardContent>
    </Card>
  );
}
