-- MIZAN governed provisioning authorization: platform owner or manager of the target central tenant.
CREATE OR REPLACE FUNCTION public.provision_tenant_user(
 p_actor_user_id UUID,p_user_id UUID,p_tenant_id UUID,p_username TEXT,p_display_name TEXT,p_role public.app_role
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_username TEXT:=lower(trim(p_username)); v_actor UUID:=auth.uid(); v_allowed BOOLEAN:=false;
BEGIN
 IF v_actor IS NULL OR p_actor_user_id IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'authentication required'; END IF;
 v_allowed:=public.is_super_admin() OR EXISTS(
   SELECT 1 FROM public.user_roles ur JOIN public.tenants ct ON ct.id=ur.tenant_id JOIN public.tenants child ON child.id=p_tenant_id
   WHERE ur.user_id=v_actor AND ur.role='manager'::public.app_role AND ct.tenant_type='central' AND child.parent_tenant_id=ct.id
 );
 IF NOT v_allowed THEN RAISE EXCEPTION 'Tenant manager permission required'; END IF;
 IF p_user_id IS NULL OR p_tenant_id IS NULL THEN RAISE EXCEPTION 'User and tenant are required'; END IF;
 IF p_role NOT IN ('manager','collector','reader') THEN RAISE EXCEPTION 'Invalid tenant role'; END IF;
 IF NOT EXISTS(
   SELECT 1 FROM public.tenants t WHERE t.id=p_tenant_id AND t.tenant_type IN('project','central')
   AND t.subscription_status='active'
   AND (public.is_super_admin() OR EXISTS(
     SELECT 1 FROM public.user_roles ur JOIN public.tenants ct ON ct.id=ur.tenant_id
     WHERE ur.user_id=v_actor AND ur.role='manager'::public.app_role AND ct.tenant_type='central' AND t.parent_tenant_id=ct.id
   ))
 ) THEN RAISE EXCEPTION 'Tenant is not active or outside actor scope'; END IF;
 IF length(v_username)<3 OR length(v_username)>80 OR v_username !~ '^[a-z0-9][a-z0-9._-]*$' THEN RAISE EXCEPTION 'Invalid username'; END IF;
 IF EXISTS(SELECT 1 FROM public.profiles p WHERE lower(p.username)=v_username AND p.id<>p_user_id) THEN RAISE EXCEPTION 'Username already exists'; END IF;
 IF EXISTS(SELECT 1 FROM public.user_roles ur WHERE ur.tenant_id=p_tenant_id AND ur.role=p_role AND ur.user_id<>p_user_id) THEN RAISE EXCEPTION 'This tenant already has this role'; END IF;
 UPDATE public.profiles SET tenant_id=p_tenant_id,username=v_username,display_name=trim(p_display_name) WHERE id=p_user_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Profile was not created by the Auth trigger'; END IF;
 INSERT INTO public.user_roles(user_id,tenant_id,role,must_change_password)
 VALUES(p_user_id,p_tenant_id,p_role,true)
 ON CONFLICT(user_id,tenant_id,role) DO UPDATE SET must_change_password=true;
 INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
 VALUES(p_tenant_id,v_actor,'user.provisioned','auth_user',p_user_id::text,
 jsonb_build_object('username',v_username,'role',p_role::text,'display_name',trim(p_display_name),'initial_password_temporary',true));
END; $$;
REVOKE ALL ON FUNCTION public.provision_tenant_user(UUID,UUID,UUID,TEXT,TEXT,public.app_role) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.provision_tenant_user(UUID,UUID,UUID,TEXT,TEXT,public.app_role) TO authenticated;