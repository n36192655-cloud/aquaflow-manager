import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  createPublicSupabaseClient,
  createSecretSupabaseClient,
  generateInitialPassword,
  generateUsername,
  requireSuperAdmin,
} from "./account.server";

const RoleSchema = z.enum(["manager", "collector", "reader"]);

const CredentialsSchema = z.object({
  username: z.string().min(3).max(80),
  password: z.string().min(12).max(128),
  role: RoleSchema,
  displayName: z.string().min(1).max(120),
  recoveryEmailConfigured: z.boolean(),
});

export const loginWithUsername = createServerFn({ method: "POST" })
  .validator(z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(128) }))
  .handler(async ({ data }) => {
    const secret = requireSecretForLookup();
    const normalized = data.username.toLowerCase();
    const { data: profile, error: profileError } = await secret
      .from("profiles")
      .select("id")
      .eq("username", normalized)
      .maybeSingle();
    if (profileError || !profile) throw new Error("bad_credentials");

    const { data: authUser, error: authUserError } = await secret.auth.admin.getUserById(profile.id);
    if (authUserError || !authUser.user?.email) throw new Error("bad_credentials");

    const publicClient = createPublicSupabaseClient();
    const { data: authData, error: signInError } = await publicClient.auth.signInWithPassword({
      email: authUser.user.email,
      password: data.password,
    });
    if (signInError || !authData.session || !authData.user) throw new Error("bad_credentials");

    return {
      access_token: authData.session.access_token,
      refresh_token: authData.session.refresh_token,
      expires_in: authData.session.expires_in,
      expires_at: authData.session.expires_at,
      token_type: authData.session.token_type,
      user_id: authData.user.id,
    };
  });

export const provisionTenantUsers = createServerFn({ method: "POST" })
  .validator(z.object({
    tenantId: z.string().uuid(),
    tenantName: z.string().min(1).max(160),
  }))
  .handler(async ({ data }) => {
    const accessToken = getRequestHeader("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!accessToken) throw new Error("Unauthorized");

    const { userId: actorId, admin } = await requireSuperAdmin(accessToken);
    const { data: tenant, error: tenantError } = await admin
      .from("tenants")
      .select("id,name,tenant_type,subscription_status")
      .eq("id", data.tenantId)
      .maybeSingle();
    if (tenantError || !tenant || tenant.tenant_type !== "project") throw new Error("Invalid project");
    if (tenant.subscription_status !== "active") throw new Error("Project is not active");

    const roles = [
      { role: "manager" as const, displayName: "مدير المشروع" },
      { role: "collector" as const, displayName: "المحصل" },
      { role: "reader" as const, displayName: "قارئ العدادات" },
    ];

    const created: Array<z.infer<typeof CredentialsSchema>> = [];

    for (const item of roles) {
      const { data: existing } = await admin
        .from("user_roles")
        .select("user_id")
        .eq("tenant_id", data.tenantId)
        .eq("role", item.role)
        .limit(1);
      if (existing && existing.length > 0) continue;

      let username = generateUsername(data.tenantName, item.role);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { data: conflict } = await admin.from("profiles").select("id").eq("username", username).maybeSingle();
        if (!conflict) break;
        username = generateUsername(data.tenantName, item.role);
      }

      const password = generateInitialPassword();
      const syntheticEmail = `${username}@mizan.local`;
      const { data: createdAuth, error: createError } = await admin.auth.admin.createUser({
        email: syntheticEmail,
        password,
        email_confirm: true,
        user_metadata: { display_name: item.displayName, username },
      });
      if (createError || !createdAuth.user) {
        throw new Error(createError?.message ?? "User creation failed");
      }

      const { error: linkError } = await admin.rpc("provision_tenant_user", {
        p_actor_user_id: actorId,
        p_user_id: createdAuth.user.id,
        p_tenant_id: data.tenantId,
        p_username: username,
        p_display_name: item.displayName,
        p_role: item.role,
      });

      if (linkError) {
        await admin.auth.admin.deleteUser(createdAuth.user.id);
        throw new Error(linkError.message);
      }

      created.push({
        username,
        password,
        role: item.role,
        displayName: item.displayName,
        recoveryEmailConfigured: false,
      });
    }

    return { tenantId: data.tenantId, credentials: created };
  });

export const requestPasswordReset = createServerFn({ method: "POST" })
  .validator(z.object({ username: z.string().trim().min(1).max(80) }))
  .handler(async ({ data }) => {
    const normalized = data.username.toLowerCase();
    const secret = requireSecretForLookup();
    const { data: profile } = await secret.from("profiles").select("id").eq("username", normalized).maybeSingle();

    // Always return the same result to avoid account enumeration.
    if (profile?.id) {
      const { data: authUser } = await secret.auth.admin.getUserById(profile.id);
      const email = authUser.user?.email ?? "";
      if (email && !email.endsWith("@mizan.local")) {
        const publicClient = createPublicSupabaseClient();
        await publicClient.auth.resetPasswordForEmail(email, {
          redirectTo: new URL("/update-password", getRequestHeader("origin") || process.env.APP_ORIGIN || "http://localhost:3000").toString(),
        });
      }
    }

    return { ok: true };
  });

function requireSecretForLookup() {
  return createSecretSupabaseClient();
}
