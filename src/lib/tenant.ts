import { supabase } from "./supabase";

export type Tenant = {
  id: string;
  name: string;
  project_name: string | null;
  tenant_type: "project" | "central";
  parent_tenant_id: string | null;
  subscription_status: string;
  subscription_expires_at: string | null;
};

export async function getCurrentTenant(tenantId: string | undefined): Promise<Tenant | null> {
  if (!tenantId) return null;
  const { data, error } = await supabase.from("tenants").select("id,name,project_name,tenant_type,parent_tenant_id,subscription_status,subscription_expires_at").eq("id", tenantId).maybeSingle();
  if (error) throw error;
  return data as Tenant | null;
}

export async function getProjectTenants(): Promise<Tenant[]> {
  const { data, error } = await supabase.rpc("project_tenants");
  if (error) throw error;
  return (data ?? []) as Tenant[];
}
