import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import { ShieldCheck, RefreshCw, LogOut, Network, Plus } from "lucide-react";

export const Route = createFileRoute("/super-admin/")({
  head: () => ({ meta: [{ title: "لوحة الإشراف المركزي — ميزان" }, { name: "robots", content: "noindex,nofollow" }] }),
  component: SuperAdminDashboard,
});

type TenantRow = {
  id: string; name: string; project_name: string | null; tenant_type: "project" | "central";
  parent_tenant_id: string | null; subscription_status: "active" | "suspended" | "expired"; subscription_expires_at: string | null;
};

function SuperAdminDashboard() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [centralName, setCentralName] = useState("الإشراف المركزي — ميزان");

  useEffect(() => {
    void (async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) { setChecking(false); navigate({ to: "/login" }); return; }
      const { data } = await supabase.rpc("is_super_admin");
      const ok = data === true;
      setAllowed(ok); setChecking(false);
      if (!ok) { toast.error("هذه الصفحة مخصّصة لمالك المنصة فقط"); navigate({ to: "/" }); return; }
      await refresh();
    })();
  }, [navigate]);

  async function refresh() {
    setLoading(true);
    const { data, error } = await supabase.from("tenants").select("id,name,project_name,tenant_type,parent_tenant_id,subscription_status,subscription_expires_at").order("created_at", { ascending: true });
    setLoading(false);
    if (error) { toast.error("تعذّر جلب المشاريع"); return; }
    setTenants((data ?? []) as TenantRow[]);
  }

  async function createCentral() {
    const { error } = await supabase.rpc("create_central_tenant", { _name: centralName.trim() });
    if (error) { toast.error(error.message.includes("already exists") ? "يوجد مستأجر مركزي بالفعل" : "تعذّر إنشاء المستأجر المركزي"); return; }
    toast.success("تم إنشاء المستأجر المركزي"); await refresh();
  }

  async function createProject() {
    if (!name.trim()) return;
    const { error } = await supabase.rpc("create_project_tenant", { _name: name.trim() });
    if (error) { toast.error("تعذّر إنشاء مشروع المياه"); return; }
    setName(""); toast.success("تم إنشاء مشروع المياه وربطه بالإشراف المركزي"); await refresh();
  }

  async function setStatus(t: TenantRow) {
    const next = t.subscription_status === "active" ? "suspended" : "active";
    const { error } = await supabase.rpc("set_tenant_subscription_status", { p_tenant_id: t.id, p_status: next });
    if (error) { toast.error("فشل تحديث الحالة"); return; }
    toast.success(next === "active" ? "تم تفعيل المشروع" : "تم تعليق المشروع"); await refresh();
  }

  if (checking) return null;
  if (!allowed) return null;

  const central = tenants.find((t) => t.tenant_type === "central");
  const projects = tenants.filter((t) => t.tenant_type === "project");

  return <div className="min-h-screen bg-background px-4 py-8" dir="rtl">
    <div className="max-w-6xl mx-auto space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div><h1 className="text-2xl font-bold flex items-center gap-2"><ShieldCheck className="w-6 h-6 text-primary" /> الإشراف المركزي — ميزان</h1><p className="text-sm text-muted-foreground mt-1">مراقبة وإدارة جميع مشاريع المياه دون خلط بيانات المستأجرين.</p></div>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className={`w-4 h-4 ml-2 ${loading ? "animate-spin" : ""}`} /> تحديث</Button>
      </header>

      <Card className="border-primary/20"><CardHeader><CardTitle className="flex items-center gap-2"><Network className="w-5 h-5" /> الهيكل المركزي</CardTitle></CardHeader><CardContent>
        {central ? <div className="rounded-lg border p-4"><div className="font-bold">{central.name}</div><div className="text-xs text-muted-foreground mt-1">مستأجر مركزي للإشراف</div><div className="mt-3 grid gap-2">{projects.map((p) => <div key={p.id} className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2"><span className="font-medium">↳ {p.name}</span><Badge>{p.subscription_status === "active" ? "نشط" : p.subscription_status === "suspended" ? "موقوف" : "منتهي"}</Badge></div>)}{projects.length === 0 && <div className="text-sm text-muted-foreground">لا توجد مشاريع مرتبطة بعد.</div>}</div></div> : <div className="space-y-3"><p className="text-sm text-muted-foreground">لم يُنشأ المستأجر المركزي بعد.</p><div className="flex gap-2"><Input value={centralName} onChange={(e) => setCentralName(e.target.value)} /><Button onClick={() => void createCentral()}><Plus className="w-4 h-4 ml-1" /> إنشاء مركزي</Button></div></div>}
      </CardContent></Card>

      <Card><CardHeader><CardTitle>إنشاء مشروع مياه</CardTitle></CardHeader><CardContent className="flex gap-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: مشروع مياه المعافر" /><Button onClick={() => void createProject()} disabled={!central || !name.trim()}>إنشاء وربط</Button></CardContent></Card>

      <Card><CardHeader><CardTitle>المشاريع ({projects.length})</CardTitle></CardHeader><CardContent className="space-y-2">{projects.map((t) => <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div><div className="font-semibold">{t.name}</div><div className="text-xs text-muted-foreground">المستأجر المركزي: {t.parent_tenant_id ? "مرتبط" : "غير مرتبط"}</div><div className="text-xs text-muted-foreground">ينتهي: {t.subscription_expires_at ? new Date(t.subscription_expires_at).toLocaleDateString("ar-YE") : "غير محدّد"}</div></div><div className="flex items-center gap-2"><Badge variant={t.subscription_status === "active" ? "default" : "destructive"}>{t.subscription_status === "active" ? "نشط" : t.subscription_status === "suspended" ? "موقوف" : "منتهي"}</Badge><Button size="sm" variant="outline" onClick={() => void setStatus(t)}>{t.subscription_status === "active" ? "تعليق" : "تفعيل"}</Button></div></div>)}{projects.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">لا توجد مشاريع.</p>}</CardContent></Card>

      <Button variant="outline" onClick={async () => { await supabase.auth.signOut(); navigate({ to: "/login", replace: true }); }}><LogOut className="w-4 h-4 ml-2" /> تسجيل الخروج</Button>
    </div>
  </div>;
}
