-- MIZAN central-manager governed project provisioning and auth lifecycle.
ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION public.create_project_tenant(_name text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_id uuid; v_name text:=btrim(_name); v_central uuid; v_uid uuid:=auth.uid();
BEGIN
 IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
 IF length(v_name)<2 OR length(v_name)>160 THEN RAISE EXCEPTION 'tenant name must be between 2 and 160 characters'; END IF;
 SELECT ur.tenant_id INTO v_central FROM public.user_roles ur JOIN public.tenants ct ON ct.id=ur.tenant_id
 WHERE ur.user_id=v_uid AND ur.role='manager'::public.app_role AND ct.tenant_type='central'
 ORDER BY ur.created_at,ur.tenant_id LIMIT 1 FOR UPDATE;
 IF public.is_super_admin() THEN
   SELECT id INTO v_central FROM public.tenants WHERE tenant_type='central' ORDER BY created_at,id LIMIT 1 FOR UPDATE;
 END IF;
 IF v_central IS NULL THEN RAISE EXCEPTION 'central manager permission required'; END IF;
 IF EXISTS(SELECT 1 FROM public.tenants WHERE parent_tenant_id=v_central AND tenant_type='project' AND lower(name)=lower(v_name))
 THEN RAISE EXCEPTION 'project tenant name already exists'; END IF;
 INSERT INTO public.tenants(name,project_name,tenant_type,parent_tenant_id,subscription_status,subscription_expires_at)
 VALUES(v_name,v_name,'project',v_central,'active',now()+interval '365 days') RETURNING id INTO v_id;
 INSERT INTO public.audit_logs(tenant_id,user_id,action,entity,entity_id,meta)
 VALUES(v_id,v_uid,'tenant.created','tenant',v_id,jsonb_build_object('tenant_type','project','name',v_name,'parent_tenant_id',v_central));
 RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.create_project_tenant(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.create_project_tenant(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_initial_password_change()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
 UPDATE public.user_roles SET must_change_password=false WHERE user_id=auth.uid();
END; $$;
REVOKE ALL ON FUNCTION public.complete_initial_password_change() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.complete_initial_password_change() TO authenticated;