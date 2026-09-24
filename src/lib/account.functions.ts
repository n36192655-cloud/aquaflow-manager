import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import {
  createPublicSupabaseClient,
  createSecretSupabaseClient,
  createUserSupabaseClient,
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

const AUTH_FAILURE_DELAY_MS = 250;
async function requireProvisioningActor(accessToken: string) {
  const userClient = createUserSupabaseClient(accessToken);
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) throw new Error("Unauthorized");
  const { data: isSuperAdmin, error: superError } = await userClient.rpc("is_super_admin");
  if (superError) throw new Error("Authorization check failed");
  if (isSuperAdmin === true) return { userId: userData.user.id, admin: createSecretSupabaseClient() };
  const { data: role, error: roleError } = await userClient
    .from("user_roles").select("tenant_id,role").eq("user_id", userData.user.id).eq("role","manager").limit(1).maybeSingle();
  if (roleError || !role?.tenant_id) throw new Error("Forbidden");
  const { data: central, error: centralError } = await userClient
    .from("tenants").select("id,tenant_type,subscription_status").eq("id",role.tenant_id).maybeSingle();
  if (centralError || central?.tenant_type !== "central" || central.subscription_status !== "active") throw new Error("Forbidden");
  return { userId: userData.user.id, centralTenantId: role.tenant_id, admin: createSecretSupabaseClient() };
}


async function opaqueRateKey(kind: string, value: string): Promise<string> {
  const input = new TextEncoder().encode(`mizan-auth-rate-v1:${kind}:${value}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function authRateAllowed(
  secret: ReturnType<typeof createSecretSupabaseClient>,
  kind: string,
  value: string,
  limit: number,
): Promise<boolean> {
  const key = await opaqueRateKey(kind, value);
  const { data, error } = await secret.rpc("consume_auth_rate_limit", {
    p_rate_key: key,
    p_limit: limit,
    p_window_seconds: 900,
  });
  return !error && data === true;
}

function requestClientKey(): string {
  const forwarded = getRequestHeader("x-forwarded-for")?.split(",")[0]?.trim();
  const vercelForwarded = getRequestHeader("x-vercel-forwarded-for")?.split(",")[0]?.trim();
  return vercelForwarded || forwarded || "unknown";
}

async function authFailure(): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, AUTH_FAILURE_DELAY_MS));
  throw new Error("bad_credentials");
}

function bearerToken(): string {
  return (
    getRequestHeader("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim() ?? ""
  );
}

export const loginWithUsername = createServerFn({ method: "POST" })
  .validator(
    z.object({
      username: z.string().trim().min(1).max(80),
      password: z.string().min(1).max(128),
    }),
  )
  .handler(async ({ data }) => {
    const secret = createSecretSupabaseClient();
    const normalized = data.username.toLowerCase();
    const ipKey = requestClientKey();
    const [usernameAllowed, ipAllowed] = await Promise.all([
      authRateAllowed(secret, "login-user", normalized, 5),
      ipKey === "unknown" ? Promise.resolve(true) : authRateAllowed(secret, "login-ip", ipKey, 30),
    ]);
    if (!usernameAllowed || !ipAllowed) return authFailure();

    const { data: profile, error: profileError } = await secret
      .from("profiles")
      .select("id")
      .eq("username", normalized)
      .maybeSingle();
    if (profileError || !profile) return authFailure();

    const { data: authUser, error: authUserError } = await secret.auth.admin.getUserById(
      profile.id,
    );
    if (authUserError || !authUser.user?.email) return authFailure();

    const publicClient = createPublicSupabaseClient();
    const { data: authData, error: signInError } = await publicClient.auth.signInWithPassword({
      email: authUser.user.email,
      password: data.password,
    });
    if (signInError || !authData.session || !authData.user) return authFailure();

    return {
      access_token: authData.session.access_token,
      refresh_token: authData.session.refresh_token,
      expires_in: authData.session.expires_in,
      expires_at: authData.session.expires_at,
      token_type: authData.session.token_type,
      user_id: authData.user.id,
    };
  });


export const createProjectTenantForCentral = createServerFn({ method: "POST" })
  .validator(z.object({ name: z.string().trim().min(2).max(160) }))
  .handler(async ({ data }) => {
    const accessToken = bearerToken();
    if (!accessToken) throw new Error("Unauthorized");
    const { userId: actorId } = await requireProvisioningActor(accessToken);
    const userClient = createUserSupabaseClient(accessToken);
    const { data: tenantId, error } = await userClient.rpc("create_project_tenant", { _name: data.name });
    if (error || !tenantId) throw new Error(error?.message ?? "Project creation failed");
    const result = await provisionTenantUsers({ data: { tenantId } });
    return { tenantId, credentials: result.credentials, actorId };
  });

export const provisionTenantUsers = createServerFn({ method: "POST" })
  .validator(z.object({ tenantId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const accessToken = bearerToken();
    if (!accessToken) throw new Error("Unauthorized");

    const { userId: actorId, admin, centralTenantId } = await requireProvisioningActor(accessToken);
    const userClient = createUserSupabaseClient(accessToken);

    const { data: tenant, error: tenantError } = await userClient
      .from("tenants")
      .select("id,name,tenant_type,subscription_status,parent_tenant_id")
      .eq("id", data.tenantId)
      .maybeSingle();

    if (tenantError || !tenant || !["project", "central"].includes(tenant.tenant_type)) {
      throw new Error("Invalid tenant");
    }
    if (tenant.subscription_status !== "active") throw new Error("Tenant is not active");
    if (centralTenantId && tenant.tenant_type === "project" && tenant.parent_tenant_id !== centralTenantId) throw new Error("Tenant outside actor scope");

    const roles = [
      { role: "manager" as const, displayName: "مدير المشروع" },
      { role: "collector" as const, displayName: "المحصل" },
      { role: "reader" as const, displayName: "قارئ العدادات" },
    ];

    const created: Array<z.infer<typeof CredentialsSchema>> = [];
    const createdUserIds: string[] = [];

    try {
      for (const item of roles) {
        const { data: existing, error: existingError } = await userClient
          .from("user_roles")
          .select("user_id")
          .eq("tenant_id", data.tenantId)
          .eq("role", item.role)
          .limit(1);

        if (existingError) throw new Error("Unable to inspect tenant users");
        if (existing && existing.length > 0) continue;

        let username = "";
        let conflict = true;
        for (let attempt = 0; attempt < 8 && conflict; attempt += 1) {
          username = generateUsername(tenant.name, item.role);
          const { data: profileConflict, error: conflictError } = await userClient
            .from("profiles")
            .select("id")
            .eq("username", username)
            .maybeSingle();
          if (conflictError) throw new Error("Unable to validate username");
          conflict = Boolean(profileConflict);
        }
        if (conflict) throw new Error("Unable to generate a unique username");

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
        createdUserIds.push(createdAuth.user.id);

        const { error: linkError } = await userClient.rpc("provision_tenant_user", {
          p_actor_user_id: actorId,
          p_user_id: createdAuth.user.id,
          p_tenant_id: data.tenantId,
          p_username: username,
          p_display_name: item.displayName,
          p_role: item.role,
        });
        if (linkError) throw new Error(linkError.message);

        created.push({
          username,
          password,
          role: item.role,
          displayName: item.displayName,
          recoveryEmailConfigured: false,
        });
      }
    } catch (error) {
      await Promise.allSettled(createdUserIds.map((id) => admin.auth.admin.deleteUser(id)));
      throw error;
    }

    return { tenantId: data.tenantId, credentials: created };
  });

export const resetTenantUserPassword = createServerFn({ method: "POST" })
  .validator(z.object({ tenantId: z.string().uuid(), userId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const accessToken = bearerToken();
    if (!accessToken) throw new Error("Unauthorized");

    const { userId: actorId, admin } = await requireSuperAdmin(accessToken);
    const userClient = createUserSupabaseClient(accessToken);

    const { data: membership, error: membershipError } = await userClient
      .from("user_roles")
      .select("user_id, tenant_id, role")
      .eq("tenant_id", data.tenantId)
      .eq("user_id", data.userId)
      .in("role", ["manager", "collector", "reader"])
      .maybeSingle();
    if (membershipError || !membership) throw new Error("Invalid tenant user");

    const { data: profile, error: profileError } = await userClient
      .from("profiles")
      .select("username")
      .eq("id", data.userId)
      .eq("tenant_id", data.tenantId)
      .maybeSingle();
    if (profileError || !profile?.username) throw new Error("Invalid tenant user");

    const password = generateInitialPassword();
    const { error: updateError } = await admin.auth.admin.updateUserById(data.userId, { password });
    if (updateError) throw new Error("Password reset failed");

    const { error: roleError } = await userClient
      .from("user_roles")
      .update({ must_change_password: true })
      .eq("tenant_id", data.tenantId)
      .eq("user_id", data.userId);
    if (roleError) throw new Error("Password reset lifecycle update failed");

    const { error: auditError } = await userClient.from("audit_logs").insert({
      tenant_id: data.tenantId,
      user_id: actorId,
      action: "user.password_reset",
      entity: "auth_user",
      entity_id: data.userId,
      meta: { role: membership.role, temporary_password_issued: true },
    });
    if (auditError) throw new Error("Password reset audit failed");

    return {
      tenantId: data.tenantId,
      userId: data.userId,
      username: profile.username,
      password,
      role: membership.role,
    };
  });

export const requestPasswordReset = createServerFn({ method: "POST" })
  .validator(z.object({ username: z.string().trim().min(1).max(80) }))
  .handler(async ({ data }) => {
    const normalized = data.username.toLowerCase();
    const secret = createSecretSupabaseClient();
    const ipKey = requestClientKey();
    const [usernameAllowed, ipAllowed] = await Promise.all([
      authRateAllowed(secret, "reset-user", normalized, 3),
      ipKey === "unknown" ? Promise.resolve(true) : authRateAllowed(secret, "reset-ip", ipKey, 10),
    ]);
    if (!usernameAllowed || !ipAllowed) return { ok: true };

    const { data: profile } = await secret
      .from("profiles")
      .select("id")
      .eq("username", normalized)
      .maybeSingle();

    if (profile?.id) {
      const { data: authUser } = await secret.auth.admin.getUserById(profile.id);
      const email = authUser.user?.email ?? "";
      if (email && !email.endsWith("@mizan.local")) {
        const appOrigin =
          process.env.APP_ORIGIN ??
          (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");

        if (appOrigin) {
          const publicClient = createPublicSupabaseClient();
          await publicClient.auth.resetPasswordForEmail(email, {
            redirectTo: new URL("/update-password", appOrigin).toString(),
          });
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, AUTH_FAILURE_DELAY_MS));
    return { ok: true };
  });
