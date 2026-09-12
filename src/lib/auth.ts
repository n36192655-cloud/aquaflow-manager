import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useLicense, type LicenseStatus } from "./license";
import { supabase } from "./supabase";

// Role IDs are stable for backwards compat with existing route/canAccess
// checks. Labels map to the water-utility RBAC contract:
//   admin  → Project Manager (مدير مشروع)   [DB role: manager]
//   reader → Meter Reader     (قارئ عدادات) [DB role: reader]
//   cashier→ Collector        (محصل)        [DB role: collector]
export type Role = "admin" | "reader" | "cashier";

export interface AuthUser {
  name: string;
  role: Role;
  seatId?: string;
  userId?: string;
  tenantId?: string;
  tenantName?: string;
  isSuperAdmin?: boolean;
}

export type LoginError = LicenseStatus | "bad_credentials" | "no_membership";

interface AuthState {
  user: AuthUser | null;
  loginError: LoginError | null;
  login: (username: string, password: string) => Promise<boolean>;
  loginWithSupabase: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  heartbeat: () => void;
  hydrateFromSupabase: () => Promise<AuthUser | null>;
}

// Usernames are mapped to a synthetic internal email so operators can sign in
// with a short username while authentication stays fully inside Supabase Auth.
const AUTH_EMAIL_DOMAIN = "mizan.local";

function usernameToEmail(username: string): string {
  const u = username.trim().toLowerCase();
  return u.includes("@") ? u : `${u}@${AUTH_EMAIL_DOMAIN}`;
}

function mapDbRole(dbRole: string | undefined): Role | null {
  if (dbRole === "manager") return "admin";
  if (dbRole === "reader") return "reader";
  if (dbRole === "collector") return "cashier";
  return null;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      loginError: null,

      // Single production login path: Supabase Auth only. There is no demo or
      // offline credential that can reach operational tenant data.
      login: async (username, password) => {
        if (!username.trim() || !password) {
          set({ loginError: "bad_credentials" });
          return false;
        }
        return useAuth.getState().loginWithSupabase(usernameToEmail(username), password);
      },

      loginWithSupabase: async (email, password) => {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: usernameToEmail(email),
          password,
        });
        if (error || !data.user) {
          set({ loginError: "bad_credentials" });
          return false;
        }

        const hydrated = await useAuth.getState().hydrateFromSupabase();
        if (!hydrated) {
          await supabase.auth.signOut();
          set({ user: null, loginError: "no_membership" });
          return false;
        }

        // Super admins are platform owners — they do not consume tenant seats.
        if (hydrated.isSuperAdmin) {
          set({ loginError: null });
          return true;
        }

        // Device/seat gate is a local UX guard on top of Supabase Auth + RLS.
        const lic = useLicense.getState();
        lic.initIfNeeded();
        const res = lic.acquireSeat(hydrated.name, hydrated.role);
        if (!res.ok) {
          await supabase.auth.signOut();
          set({ user: null, loginError: res.reason ?? "invalid" });
          return false;
        }
        set({ user: { ...hydrated, seatId: res.seatId }, loginError: null });
        return true;
      },

      hydrateFromSupabase: async () => {
        const { data: userData } = await supabase.auth.getUser();
        const authUser = userData.user;
        if (!authUser) {
          set({ user: null });
          return null;
        }

        const [{ data: isSuper }, { data: profile }, { data: roles }] = await Promise.all([
          supabase.rpc("is_super_admin"),
          supabase
            .from("profiles")
            .select("tenant_id, display_name")
            .eq("id", authUser.id)
            .maybeSingle(),
          supabase.from("user_roles").select("role, tenant_id").eq("user_id", authUser.id),
        ]);

        const isSuperAdmin = isSuper === true;
        const tenantId = profile?.tenant_id ?? undefined;
        const dbRole = (roles ?? []).find((r) => r.tenant_id && r.tenant_id === tenantId)?.role;
        const role = mapDbRole(dbRole);

        // A non-super-admin must be a member of exactly one tenant with a
        // valid operational role, otherwise there is no data they may see.
        if (!isSuperAdmin && (!tenantId || !role)) {
          set({ user: null });
          return null;
        }

        let tenantName: string | undefined;
        if (tenantId) {
          const { data: tenant } = await supabase
            .from("tenants")
            .select("name, project_name")
            .eq("id", tenantId)
            .maybeSingle();
          tenantName = tenant?.project_name ?? tenant?.name ?? undefined;
        }

        const next: AuthUser = {
          name: profile?.display_name ?? authUser.email?.split("@")[0] ?? "مستخدم",
          role: role ?? "admin",
          userId: authUser.id,
          tenantId,
          tenantName,
          isSuperAdmin,
        };
        set({ user: next, loginError: null });
        return next;
      },

      logout: async () => {
        const u = (useAuth.getState() as AuthState).user;
        if (u?.seatId) useLicense.getState().releaseSeat(u.seatId);
        set({ user: null, loginError: null });
        await supabase.auth.signOut();
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
