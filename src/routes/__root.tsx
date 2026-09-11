import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/app-shell";
import { supabase } from "@/lib/supabase";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "منصة ميزان — إدارة عدادات المياه" },
      {
        name: "description",
        content:
          "نظام سحابي متعدد المستأجرين لإدارة مشاريع مياه اليمن: المشتركون، القراءات، الفواتير، التحصيل، وتحليل الفاقد.",
      },
      { name: "author", content: "MIZAN" },
      { property: "og:title", content: "منصة ميزان — إدارة مشاريع المياه" },
      { property: "og:description", content: "إدارة كاملة لعدادات وفواتير المياه في اليمن." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <SubscriptionGuard>
        <AppShell>
          <Outlet />
        </AppShell>
      </SubscriptionGuard>
      <Toaster position="top-center" richColors />
    </QueryClientProvider>
  );
}

/**
 * Low-cost global subscription guard.
 *
 * Checks the current tenant's `subscription_status` and
 * `subscription_expires_at` on mount + whenever the route changes.
 * If the tenant is suspended or past expiration, the entire UI is
 * intercepted and a lock screen is shown instead. Super-admins bypass
 * the guard so the owner dashboard remains reachable.
 */
function SubscriptionGuard({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "ok" | "locked">("loading");
  const [reason, setReason] = useState<"suspended" | "expired" | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const { data: userData } = await supabase.auth.getUser();
        if (!userData.user) {
          if (alive) setState("ok"); // Public routes (login) handle their own gating
          return;
        }
        // Super admins are never locked out
        const { data: roles } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userData.user.id);
        if ((roles ?? []).some((r: { role: string }) => r.role === "super_admin")) {
          if (alive) setState("ok");
          return;
        }
        const { data: profile } = await supabase
          .from("profiles")
          .select("tenant_id")
          .eq("id", userData.user.id)
          .maybeSingle();
        if (!profile?.tenant_id) {
          if (alive) setState("ok");
          return;
        }
        const { data: tenant } = await supabase
          .from("tenants")
          .select("subscription_status, subscription_expires_at")
          .eq("id", profile.tenant_id)
          .maybeSingle();
        if (!tenant) {
          if (alive) setState("ok");
          return;
        }
        const expired =
          tenant.subscription_expires_at &&
          new Date(tenant.subscription_expires_at).getTime() < Date.now();
        if (tenant.subscription_status === "suspended") {
          if (alive) {
            setReason("suspended");
            setState("locked");
          }
          return;
        }
        if (tenant.subscription_status === "expired" || expired) {
          if (alive) {
            setReason("expired");
            setState("locked");
          }
          return;
        }
        if (alive) setState("ok");
      } catch {
        if (alive) setState("ok");
      }
    };
    void check();
    return () => {
      alive = false;
    };
  }, []);

  if (state === "loading") return null;
  if (state === "locked") return <SubscriptionLockScreen reason={reason} />;
  return <>{children}</>;
}

function SubscriptionLockScreen({ reason }: { reason: "suspended" | "expired" | null }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4" dir="rtl">
      <div className="max-w-md text-center space-y-4">
        <div className="mx-auto w-16 h-16 rounded-2xl bg-destructive/10 grid place-items-center">
          <span className="text-3xl">🔒</span>
        </div>
        <h1 className="text-2xl font-bold text-foreground">
          {reason === "expired" ? "انتهى الاشتراك" : "الاشتراك موقوف"}
        </h1>
        <p className="text-sm text-muted-foreground">
          مشروع المياه الخاص بك غير قادر على استخدام منصة ميزان في الوقت الحالي. يرجى التواصل مع
          مالك المنصة لتفعيل الاشتراك مرة أخرى.
        </p>
        <div className="rounded-lg bg-muted p-4 text-xs text-muted-foreground">
          Subscription Expired — Contact Platform Owner
        </div>
      </div>
    </div>
  );
}
