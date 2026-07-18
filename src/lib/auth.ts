import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useLicense, type LicenseStatus } from "./license";

export type Role = "admin" | "reader" | "cashier";

export interface AuthUser {
  name: string;
  role: Role;
  seatId?: string;
}

interface AuthState {
  user: AuthUser | null;
  loginError: LicenseStatus | "bad_credentials" | null;
  login: (name: string, role: Role, password: string) => boolean;
  logout: () => void;
  heartbeat: () => void;
}

// Offline-only demo credentials
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
      logout: () => {
        const u = (useAuth.getState() as AuthState).user;
        if (u?.seatId) useLicense.getState().releaseSeat(u.seatId);
        set({ user: null });
      },
      heartbeat: () => {
        const u = (useAuth.getState() as AuthState).user;
        if (u?.seatId) useLicense.getState().touchSeat(u.seatId);
      },
    }),
    { name: "mizan-auth-v1" },
  ),
);

export const ROLE_LABEL: Record<Role, string> = {
  admin: "المدير",
  reader: "قارئ ميداني",
  cashier: "محصل مالي",
};

export function canAccess(role: Role | undefined, path: string): boolean {
  if (!role) return false;
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