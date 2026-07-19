import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useLicense, type LicenseStatus } from "./license";
import { supabase } from "./supabase";

// Role IDs are stable for backwards compat with existing route/canAccess
// checks. Labels have been repointed to the water-utility RBAC contract:
//   admin  → Project Manager (مدير مشروع)
//   reader → Meter Reader     (قارئ عدادات)
//   cashier→ Collector        (محصل)
export type Role = "admin" | "reader" | "cashier";

export interface AuthUser {
  name: string;
  role: Role;
  seatId?: string;
  userId?: string;
  tenantId?: string;
  isSuperAdmin?: boolean;
}

interface AuthState {
  user: AuthUser | null;
  loginError: LicenseStatus | "bad_credentials" | null;
  login: (name: string, role: Role, password: string) => Promise<boolean>;
  loginWithSupabase: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  heartbeat: () => void;
  hydrateFromSupabase: () => Promise<void>;
}


// Offline-only demo credentials used when the app runs without a Supabase session
const DEMO_PASSWORD = "1234";

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      loginError: null,

      login: (name, role, password) => {
        if (password !== DEMO_PASSWORD || !name.trim()) {
          set({ loginError: "bad_credentials" });
          return false;
        }
        const lic = useLicense.getState();
        lic.initIfNeeded();
        const res = lic.acquireSeat(name.trim(), role);
        if (!res.ok) {
          set({ loginError: res.reason ?? "invalid" });
          return false;
        }
        set({ user: { name: name.trim(), role, seatId: res.seatId }, loginError: null });
        return true;
      },

      loginWithSupabase: async (email, password) => {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error || !data.user) {
          set({ loginError: "bad_credentials" });
          return false;
        }
        await useAuth.getState().hydrateFromSupabase();
        return true;
      },

      hydrateFromSupabase: async () => {
        const { data: userData } = await supabase.auth.getUser();
        const user = userData.user;
        if (!user) {
          set({ user: null });
          return;
        }
        const { data: profile } = await supabase
          .from("profiles")
          .select("tenant_id, display_name")
          .eq("id", user.id)
          .maybeSingle();
        const { data: roles } = await supabase
          .from("user_roles")
          .select("role, tenant_id")
          .eq("user_id", user.id);

        const isSuperAdmin = (roles ?? []).some((r) => r.role === "super_admin");
        const tenantRole = (roles ?? []).find(
          (r) => r.tenant_id && r.tenant_id === profile?.tenant_id,
        )?.role;

        // Map DB roles → legacy role IDs
        let role: Role = "admin";
        if (tenantRole === "reader") role = "reader";
        else if (tenantRole === "collector") role = "cashier";
        else if (tenantRole === "manager") role = "admin";

        set({
          user: {
            name: profile?.display_name ?? user.email ?? "مستخدم",
            role,
            userId: user.id,
            tenantId: profile?.tenant_id ?? undefined,
            isSuperAdmin,
          },
          loginError: null,
        });
      },

      logout: () => {
        const u = (useAuth.getState() as AuthState).user;
        if (u?.seatId) useLicense.getState().releaseSeat(u.seatId);
        void supabase.auth.signOut();
        set({ user: null });
      },

      heartbeat: () => {
        const u = (useAuth.getState() as AuthState).user;
        if (u?.seatId) useLicense.getState().touchSeat(u.seatId);
      },
    }),
    { name: "mizan-auth-v2" },
  ),
);

// Labels reflect the water-utility RBAC contract.
export const ROLE_LABEL: Record<Role, string> = {
  admin: "مدير مشروع",
  reader: "قارئ عدادات",
  cashier: "محصل",
};

export function canAccess(role: Role | undefined, path: string): boolean {
  if (!role) return false;
  if (path.startsWith("/super-admin")) return false;
  if (role === "admin") return true;
  if (role === "reader") return path === "/readings";
  if (role === "cashier") return path === "/bills" || path === "/payments";
  return false;
}

export function defaultRouteFor(role: Role): string {
  if (role === "reader") return "/readings";
  if (role === "cashier") return "/bills";
  return "/";
}
