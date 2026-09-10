import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, Link, createRootRouteWithContext, useRouter, HeadContent, Scripts } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/app-shell";
import { supabase } from "@/lib/supabase";

function NotFoundComponent() { return <div className="flex min-h-screen items-center justify-center bg-background px-4"><div className="max-w-md text-center"><h1 className="text-7xl font-bold">404</h1><h2 className="mt-4 text-xl font-semibold">الصفحة غير موجودة</h2><p className="mt-2 text-sm text-muted-foreground">الصفحة المطلوبة غير موجودة أو تم نقلها.</p><div className="mt-6"><Link to="/" className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">العودة للرئيسية</Link></div></div></div>; }
function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) { console.error(error); const router = useRouter(); useEffect(() => { reportLovableError(error, { boundary: "tanstack_root_error_component" }); }, [error]); return <div className="flex min-h-screen items-center justify-center bg-background px-4"><div className="max-w-md text-center"><h1 className="text-xl font-semibold">تعذر تحميل الصفحة</h1><p className="mt-2 text-sm text-muted-foreground">حدث خطأ. حاول التحديث أو العودة للرئيسية.</p><button onClick={() => { router.invalidate(); reset(); }} className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">حاول مرة أخرى</button></div></div>; }

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({ meta: [
    { charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" },
    { title: "منصة ميزان لإستدامة خدمات المياه" },
    { name: "description", content: "منصة ميزان لإستدامة خدمات المياه — إدارة المشتركين والعدادات والقراءات والفواتير والتحصيل والفاقد." },
    { name: "author", content: "MIZAN" }, { property: "og:title", content: "منصة ميزان لإستدامة خدمات المياه" },
    { property: "og:description", content: "إدارة تشغيلية متكاملة لخدمات المياه." }, { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary_large_image" },
  ], links: [{ rel: "stylesheet", href: appCss }, { rel: "icon", href: "/favicon.ico", type: "image/x-icon" }, { rel: "preconnect", href: "https://fonts.googleapis.com" }, { rel: "preconnect", href: "https://fonts.gstatic.com" }, { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&display=swap" }] }),
  shellComponent: RootShell, component: RootComponent, notFoundComponent: NotFoundComponent, errorComponent: ErrorComponent,
});
function RootShell({ children }: { children: ReactNode }) { return <html lang="ar" dir="rtl"><head><HeadContent /></head><body>{children}<Scripts /></body></html>; }
function RootComponent() { const { queryClient } = Route.useRouteContext(); return <QueryClientProvider client={queryClient}><SubscriptionGuard><AppShell><Outlet /></AppShell></SubscriptionGuard><Toaster position="top-center" richColors /></QueryClientProvider>; }

function SubscriptionGuard({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "ok" | "locked">("loading"); const [reason, setReason] = useState<"suspended" | "expired" | null>(null);
  useEffect(() => { let alive = true; const check = async () => { try {
    const { data: userData } = await supabase.auth.getUser(); if (!userData.user) { if (alive) setState("ok"); return; }
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userData.user.id);
    if ((roles ?? []).some((r: { role: string }) => r.role === "super_admin")) { if (alive) setState("ok"); return; }
    const { data: profile } = await supabase.from("profiles").select("tenant_id").eq("id", userData.user.id).maybeSingle(); if (!profile?.tenant_id) { if (alive) setState("ok"); return; }
    const { data: tenant } = await supabase.from("tenants").select("subscription_status, subscription_expires_at").eq("id", profile.tenant_id).maybeSingle(); if (!tenant) { if (alive) setState("ok"); return; }
    const expired = tenant.subscription_expires_at && new Date(tenant.subscription_expires_at).getTime() < Date.now();
    if (tenant.subscription_status === "suspended" || tenant.subscription_status === "expired" || expired) { if (alive) { setReason(tenant.subscription_status === "suspended" ? "suspended" : "expired"); setState("locked"); } return; }
    if (alive) setState("ok");
  } catch { if (alive) setState("ok"); } }; void check(); return () => { alive = false; }; }, []);
  if (state === "loading") return null; if (state === "locked") return <SubscriptionLockScreen reason={reason} />; return <>{children}</>;
}
function SubscriptionLockScreen({ reason }: { reason: "suspended" | "expired" | null }) { return <div className="min-h-screen flex items-center justify-center bg-background px-4" dir="rtl"><div className="max-w-md text-center space-y-4"><div className="mx-auto w-16 h-16 rounded-2xl bg-destructive/10 grid place-items-center"><span className="text-3xl">🔒</span></div><h1 className="text-2xl font-bold">{reason === "expired" ? "انتهى الاشتراك" : "الاشتراك موقوف"}</h1><p className="text-sm text-muted-foreground">مشروع المياه الخاص بك غير قادر على استخدام منصة ميزان في الوقت الحالي. يرجى التواصل مع مالك المنصة.</p><div className="rounded-lg bg-muted p-4 text-xs text-muted-foreground">منصة ميزان لإستدامة خدمات المياه</div></div></div>; }
