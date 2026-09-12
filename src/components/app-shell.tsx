import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ClipboardList, Droplets, Gauge, LayoutDashboard, LogOut, Receipt, Scale, ShieldCheck, TrendingDown, UserRound, Users, Wallet } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { canAccess, defaultRouteFor, ROLE_LABEL, useAuth, type Role } from "@/lib/auth";
import { NetworkStatus } from "./network-status";
import { CopyrightFooter } from "./footer";
import { syncPending, useOnlineStatus } from "@/lib/sync";
import { useLicense } from "@/lib/license";
import { getCurrentTenant, type Tenant } from "@/lib/tenant";

type NavItem = { to: string; label: string; icon: typeof LayoutDashboard; roles: Role[] };
const NAV: NavItem[] = [
  { to: "/", label: "لوحة التحكم", icon: LayoutDashboard, roles: ["admin"] },
  { to: "/customers", label: "المشتركون", icon: Users, roles: ["admin"] },
  { to: "/meters", label: "العدادات", icon: Gauge, roles: ["admin"] },
  { to: "/readings", label: "القراءات", icon: ClipboardList, roles: ["admin", "reader"] },
  { to: "/bills", label: "الفواتير", icon: Receipt, roles: ["admin", "cashier"] },
  { to: "/payments", label: "التحصيل", icon: Wallet, roles: ["admin", "cashier"] },
  { to: "/loss-analysis", label: "تحليل الفاقد", icon: TrendingDown, roles: ["admin"] },
  { to: "/assistant", label: "ميزان الذكي", icon: Scale, roles: ["admin"] },
  { to: "/subscription", label: "الاشتراك", icon: ShieldCheck, roles: ["admin"] },
  { to: "/account", label: "حسابي", icon: UserRound, roles: ["admin", "reader", "cashier"] },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { user, logout, heartbeat } = useAuth();
  const online = useOnlineStatus();
  const license = useLicense();
  const [tenant, setTenant] = useState<Tenant | null>(null);

  useEffect(() => { license.initIfNeeded(); }, [license]);
  useEffect(() => { if (!user?.tenantId) { setTenant(null); return; } let alive = true; void getCurrentTenant(user.tenantId).then((t) => { if (alive) setTenant(t); }).catch(() => { if (alive) setTenant(null); }); return () => { alive = false; }; }, [user?.tenantId]);
  useEffect(() => {
    const status = license.validate();
    if (status !== "active" && pathname !== "/subscription" && pathname !== "/login") navigate({ to: "/subscription", replace: true });
  }, [pathname, license, navigate]);
  useEffect(() => {
    if (pathname === "/login") return;
    if (!user) { navigate({ to: "/login", replace: true }); return; }
    if (pathname === "/subscription") return;
    if (!canAccess(user.role, pathname)) navigate({ to: defaultRouteFor(user.role), replace: true });
  }, [pathname, user, navigate]);
  useEffect(() => { if (online) void syncPending(); }, [online]);
  useEffect(() => { if (!user?.seatId) return; heartbeat(); const timer = setInterval(() => heartbeat(), 60_000); return () => clearInterval(timer); }, [user?.seatId, heartbeat]);

  if (pathname === "/login" || !user) return <>{children}</>;
  if (license.validate() !== "active" || pathname === "/subscription") return <>{children}</>;
  const nav = NAV.filter((item) => item.roles.includes(user.role));
  const renderNav = (mobile = false) => nav.map((item) => { const active = pathname === item.to || (item.to !== "/" && pathname.startsWith(item.to)); const Icon = item.icon; return <Link key={item.to} to={item.to} className={cn(mobile ? "flex flex-col items-center gap-1 py-2 text-[10px]" : "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors", active ? "bg-sidebar-accent text-sidebar-primary font-semibold" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground")}><Icon className="w-4 h-4" /><span>{item.label}</span></Link>; });

  return <div className="min-h-screen flex w-full bg-background text-foreground">
    <aside className="hidden md:flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-l border-sidebar-border">
      <div className="px-5 py-6 border-b border-sidebar-border"><div className="flex items-center gap-2"><div className="relative w-9 h-9 rounded-xl grid place-items-center bg-water"><Droplets className="w-5 h-5 text-white" /></div><div><div className="text-lg font-bold tracking-tight">ميزان</div><div className="text-[11px] text-sidebar-foreground/70">منصة ميزان لإستدامة خدمات المياه</div></div></div>{tenant && <div className="mt-4 rounded-lg bg-sidebar-accent/60 px-3 py-2"><div className="text-[10px] text-sidebar-foreground/60">المشروع الحالي</div><div className="text-sm font-bold truncate" title={tenant.name}>{tenant.name}</div></div>}</div>
      <nav className="flex-1 px-3 py-4 space-y-1">{renderNav()}</nav>
      <div className="px-4 py-4 border-t border-sidebar-border space-y-2"><div className="text-xs"><div className="font-semibold">{user.name}</div><div className="text-sidebar-foreground/60">{ROLE_LABEL[user.role]}</div></div><button onClick={() => { logout(); navigate({ to: "/login", replace: true }); }} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-sidebar-foreground/80 hover:bg-sidebar-accent/60"><LogOut className="w-3 h-3" /> تسجيل الخروج</button><div className="text-[10px] text-sidebar-foreground/50 pt-2 border-t border-sidebar-border/60">تعز — اليمن · منصة ميزان لإستدامة خدمات المياه</div></div>
    </aside>
    <div className="flex-1 flex flex-col min-w-0">
      <header className="bg-card border-b px-4 py-2 flex items-center justify-between gap-2"><div className="md:hidden font-bold truncate">{tenant?.name ?? "منصة ميزان لإستدامة خدمات المياه"}</div><div className="hidden md:flex items-center gap-3 text-xs"><span className="font-bold">{tenant?.name ?? "غير محدد"}</span><span className="text-muted-foreground">{ROLE_LABEL[user.role]} — {user.name}</span></div><NetworkStatus /></header>
      <main className="flex-1 p-4 md:p-8 max-w-[1400px] w-full mx-auto">{children}</main>
      <CopyrightFooter className="border-t" />
      <nav className="md:hidden sticky bottom-0 grid bg-sidebar text-sidebar-foreground border-t border-sidebar-border" style={{ gridTemplateColumns: `repeat(${nav.length + 1}, minmax(0, 1fr))` }}>{renderNav(true)}<button onClick={() => { logout(); navigate({ to: "/login", replace: true }); }} className="flex flex-col items-center gap-1 py-2 text-[10px] text-sidebar-foreground/70"><LogOut className="w-4 h-4" /><span>خروج</span></button></nav>
    </div>
  </div>;
}
