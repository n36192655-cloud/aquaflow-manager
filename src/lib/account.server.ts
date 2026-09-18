import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type DbClient = SupabaseClient<Database>;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server environment variable: ${name}`);
  return value;
}

export function createSecretSupabaseClient(): DbClient {
  return createClient<Database>(env("SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function createUserSupabaseClient(accessToken: string): DbClient {
  return createClient<Database>(env("SUPABASE_URL"), process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? env("SUPABASE_PUBLISHABLE_KEY"), {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function createPublicSupabaseClient(): DbClient {
  return createClient<Database>(env("SUPABASE_URL"), env("SUPABASE_PUBLISHABLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export function generateInitialPassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*+-_";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

export function generateUsername(tenantSlug: string, role: "manager" | "collector" | "reader"): string {
  const roleCode = role === "manager" ? "manager" : role === "collector" ? "collector" : "reader";
  const bytes = new Uint32Array(5);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (value) => (value % 36).toString(36)).join("").slice(0, 5);
  const base = tenantSlug
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 24) || "project";
  return `mizan-${base}-${roleCode}-${suffix}`;
}

export async function requireSuperAdmin(accessToken: string): Promise<{ userId: string; admin: DbClient }> {
  const userClient = createUserSupabaseClient(accessToken);
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) throw new Error("Unauthorized");
  const { data: isSuperAdmin, error: roleError } = await userClient.rpc("is_super_admin");
  if (roleError || isSuperAdmin !== true) throw new Error("Forbidden");
  return { userId: userData.user.id, admin: createSecretSupabaseClient() };
}
