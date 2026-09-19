import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useLicense, type LicenseStatus } from "./license";
import { supabase } from "./supabase";
import { loginWithUsername } from "./account.functions";

export type Role = "admin" | "reader" | "cashier";
export interface AuthUser {
  name: string;
  username?: string;
  role: Role;
  seatId?: string;
  userId?: string;
  tenantId?: string;
  isSuperAdmin?: boolean;
  mustChangePassword?: boolean;
}
interface AuthState {
  user: AuthUser | null;
  loginError: LicenseStatus | "bad_credentials" | "not_configured" | null;
  login: (username: string, password: string) => Promise<boolean>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<boolean>;
  logout: () => void;
  heartbeat: () => void;
  hydrateFromSupabase: () => Promise<void>;
}
export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      loginError: null,
      login: async (username, password) => {
        const normalizedUsername = username.trim().toLowerCase();
        if (!normalizedUsername || !password) {
          set({ loginError: "bad_credentials" });
          return false;
        }
        try {
          const authResult = await loginWithUsername({
            data: { username: normalizedUsername, password },
          }).catch(() => null);
          if (!authResult?.access_token || !authResult.refresh_token) {
            set({ loginError: "bad_credentials" });
            return false;
          }
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: authResult.access_token,
            refresh_token: authResult.refresh_token,
          });
          if (sessionError) {
            set({ loginError: "bad_credentials" });
            return false;
          }
          await useAuth.getState().hydrateFromSupabase();
          const u = useAuth.getState().user;
          if (!u) {
            set({ loginError: "bad_credentials" });
            return false;
          }
          const lic = useLicense.getState();
          lic.initIfNeeded();
          if (!u.isSuperAdmin) {
            if (!u.tenantId) {
              await supabase.auth.signOut();
              set({ user: null, loginError: "invalid" });
              return false;
            }
            const subscriptionStatus = await lic.validateRemote(u.tenantId);
            if (subscriptionStatus !== "active") {
              await supabase.auth.signOut();
              set({ user: null, loginError: subscriptionStatus });
              return false;
            }
          }
          const seat = lic.acquireSeat(u.userId ?? normalizedUsername, u.role);
          if (!seat.ok) {
            await supabase.auth.signOut();
            set({ user: null, loginError: seat.reason ?? "invalid" });
            return false;
          }
          set({ user: { ...u, seatId: seat.seatId }, loginError: null });
          return true;
        } catch (error) {
          console.error("[Mizan] authentication failed", error);
          set({ loginError: "not_configured" });
          return false;
        }
      },
      changePassword: async (currentPassword, newPassword) => {
        if (!currentPassword || newPassword.length < 12) return false;

        const { error: updateError } = await supabase.auth.updateUser({
          password: newPassword,
          current_password: currentPassword,
        });
        if (updateError) return false;

        const { error: passwordSetupError } = await supabase.rpc(
          "complete_initial_password_change",
        );
        if (passwordSetupError) return false;

        // A password change is a credential-security event: revoke refresh-token
        // sessions on every device and force a fresh login.
        await supabase.auth.signOut({ scope: "global" });
        const current = useAuth.getState().user;
        if (current?.seatId) useLicense.getState().releaseSeat(current.seatId);
        set({ user: null, loginError: null });
        return true;
      },
      logout: () => {
        const u = useAuth.getState().user;
        if (u?.seatId) useLicense.getState().releaseSeat(u.seatId);
        void supabase.auth.signOut({ scope: "local" });
        set({ user: null, loginError: null });
      },
      hydrateFromSupabase: async () => {
        const { data: userData } = await supabase.auth.getUser();
        const user = userData.user;
        if (!user) {
          set({ user: null });
          return;
        }
        const [
          { data: isSuperAdmin, error: superAdminError },
          { data: profile, error: profileError },
        ] = await Promise.all([
          supabase.rpc("is_super_admin"),
          supabase
            .from("profiles")
            .select("tenant_id, display_name, username")
            .eq("id", user.id)
            .maybeSingle(),
        ]);
        if (superAdminError) throw superAdminError;
        if (profileError) throw profileError;
        const { data: roles, error: roleError } = await supabase
          .from("user_roles")
          .select("role, tenant_id, must_change_password")
          .eq("user_id", user.id);
        if (roleError) throw roleError;
        const tenantRole = (roles ?? []).find(
          (r) => r.tenant_id && r.tenant_id === profile?.tenant_id,
        );
        let role: Role;
        if (tenantRole?.role === "reader") role = "reader";
        else if (tenantRole?.role === "collector") role = "cashier";
        else if (tenantRole?.role === "manager") role = "admin";
        else if (isSuperAdmin === true) role = "admin";
        else {
          set({ user: null, loginError: "bad_credentials" });
          await supabase.auth.signOut();
          return;
        }
        set({
          user: {
            name: profile?.display_name ?? normalizedUsernameFromAuthEmail(user.email) ?? "مستخدم",
            username: profile?.username ?? normalizedUsernameFromAuthEmail(user.email),
            role,
            userId: user.id,
            tenantId: profile?.tenant_id ?? undefined,
            isSuperAdmin: isSuperAdmin === true,
            mustChangePassword: tenantRole?.must_change_password === true,
          },
          loginError: null,
        });
      },
      heartbeat: () => {
        const u = useAuth.getState().user;
        if (u?.seatId) useLicense.getState().touchSeat(u.seatId);
      },
    }),
    { name: "mizan-auth-v4" },
  ),
);

// The persisted Zustand snapshot is only a UI cache. Supabase Auth remains the
// source of truth and every auth lifecycle event rehydrates the tenant/role state.
if (typeof window !== "undefined") {
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      const current = useAuth.getState().user;
      if (current?.seatId) useLicense.getState().releaseSeat(current.seatId);
      useAuth.setState({ user: null, loginError: null });
      return;
    }

    if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
      window.setTimeout(() => {
        void useAuth
          .getState()
          .hydrateFromSupabase()
          .catch(() => {
            useAuth.setState({ user: null, loginError: "bad_credentials" });
          });
      }, 0);
    }
  });
}

function normalizedUsernameFromAuthEmail(email?: string | null): string | undefined {
  if (!email) return undefined;
  const suffix = "@mizan.local";
  return email.endsWith(suffix) ? email.slice(0, -suffix.length) : undefined;
}
export const ROLE_LABEL: Record<Role, string> = {
  admin: "مدير مشروع",
  reader: "قارئ عدادات",
  cashier: "محصل",
};
export function canAccess(role: Role | undefined, path: string, isSuperAdmin = false): boolean {
  if (!role) return false;
  if (isSuperAdmin) return true;
  if (role === "admin") return true;
  if (role === "reader") return path === "/readings" || path === "/account";
  if (role === "cashier") return path === "/bills" || path === "/payments" || path === "/account";
  return false;
}
export function defaultRouteFor(role: Role, isSuperAdmin = false): string {
  if (isSuperAdmin) return "/super-admin";
  if (role === "reader") return "/readings";
  if (role === "cashier") return "/bills";
  return "/";
}
