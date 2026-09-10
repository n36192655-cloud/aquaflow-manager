import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useLicense, type LicenseStatus } from "./license";
import { supabase } from "./supabase";
export type Role = "admin" | "reader" | "cashier";
export interface AuthUser { name: string; username?: string; role: Role; seatId?: string; userId?: string; tenantId?: string; isSuperAdmin?: boolean; }
interface AuthState { user: AuthUser | null; loginError: LicenseStatus | "bad_credentials" | "not_configured" | null; login: (username: string, password: string) => Promise<boolean>; changePassword: (newPassword: string) => Promise<boolean>; logout: () => void; heartbeat: () => void; hydrateFromSupabase: () => Promise<void>; }
export const useAuth = create<AuthState>()(persist((set) => ({
  user: null, loginError: null,
  login: async (username, password) => {
    if (!username.trim() || !password) { set({ loginError: "bad_credentials" }); return false; }
    try {
      const { data: loginEmail, error: lookupError } = await supabase.rpc("resolve_login_email", { p_username: username.trim() });
      if (lookupError || !loginEmail) { set({ loginError: "bad_credentials" }); return false; }
      const { data, error } = await supabase.auth.signInWithPassword({ email: String(loginEmail), password });
      if (error || !data.user) { set({ loginError: "bad_credentials" }); return false; }
      await useAuth.getState().hydrateFromSupabase(); const u = useAuth.getState().user; if (!u) { set({ loginError: "bad_credentials" }); return false; }
      const lic = useLicense.getState(); lic.initIfNeeded(); const seat = lic.acquireSeat(u.userId ?? username, u.role);
      if (!seat.ok) { await supabase.auth.signOut(); set({ user: null, loginError: seat.reason ?? "invalid" }); return false; }
      set({ user: { ...u, seatId: seat.seatId }, loginError: null }); return true;
    } catch (error) { console.error("[Mizan] authentication failed", error); set({ loginError: "not_configured" }); return false; }
  },
  changePassword: async (newPassword) => {
    if (newPassword.length < 8) return false;
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    return !error;
  },
  logout: () => { const u = useAuth.getState().user; if (u?.seatId) useLicense.getState().releaseSeat(u.seatId); void supabase.auth.signOut(); set({ user: null, loginError: null }); },
  hydrateFromSupabase: async () => {
    const { data: userData } = await supabase.auth.getUser(); const user = userData.user; if (!user) { set({ user: null }); return; }
    const { data: profile, error: profileError } = await supabase.from("profiles").select("tenant_id, display_name, username").eq("id", user.id).maybeSingle(); if (profileError) throw profileError;
    const { data: roles, error: roleError } = await supabase.from("user_roles").select("role, tenant_id").eq("user_id", user.id); if (roleError) throw roleError;
    const isSuperAdmin = (roles ?? []).some((r) => r.role === "super_admin"); const tenantRole = (roles ?? []).find((r) => r.tenant_id && r.tenant_id === profile?.tenant_id)?.role;
    let role: Role; if (tenantRole === "reader") role = "reader"; else if (tenantRole === "collector") role = "cashier"; else if (tenantRole === "manager") role = "admin"; else { set({ user: null, loginError: "bad_credentials" }); await supabase.auth.signOut(); return; }
    set({ user: { name: profile?.display_name ?? profile?.username ?? user.email ?? "مستخدم", username: profile?.username ?? undefined, role, userId: user.id, tenantId: profile?.tenant_id ?? undefined, isSuperAdmin }, loginError: null });
  },
  heartbeat: () => { const u = useAuth.getState().user; if (u?.seatId) useLicense.getState().touchSeat(u.seatId); },
}), { name: "mizan-auth-v4" }));
export const ROLE_LABEL: Record<Role, string> = { admin: "مدير مشروع", reader: "قارئ عدادات", cashier: "محصل" };
export function canAccess(role: Role | undefined, path: string): boolean { if (!role) return false; if (path.startsWith("/super-admin")) return false; if (role === "admin") return true; if (role === "reader") return path === "/readings" || path === "/account"; if (role === "cashier") return path === "/bills" || path === "/payments" || path === "/account"; return false; }
export function defaultRouteFor(role: Role): string { if (role === "reader") return "/readings"; if (role === "cashier") return "/bills"; return "/"; }
