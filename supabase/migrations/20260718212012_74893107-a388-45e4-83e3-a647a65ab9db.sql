
-- 1. ENUM for roles
CREATE TYPE public.app_role AS ENUM ('super_admin', 'manager', 'reader', 'collector');
CREATE TYPE public.subscription_status AS ENUM ('active', 'suspended', 'expired');

-- 2. TENANTS
CREATE TABLE public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  subscription_status public.subscription_status NOT NULL DEFAULT 'active',
  subscription_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants TO authenticated;
GRANT ALL ON public.tenants TO service_role;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

-- 3. PROFILES
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  display_name TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 4. USER_ROLES
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- 5. Security definer helpers
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT public.has_role(auth.uid(), 'super_admin'); $$;

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT tenant_id FROM public.profiles WHERE id = auth.uid(); $$;

CREATE OR REPLACE FUNCTION public.has_tenant_role(_tenant_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = _role
      AND (tenant_id = _tenant_id OR role = 'super_admin')
  );
$$;

-- 6. Auto profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 7. Updated_at trigger
CREATE OR REPLACE FUNCTION public.tg_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- 8. RLS Policies: tenants
CREATE POLICY "read own tenant or super admin" ON public.tenants FOR SELECT TO authenticated
  USING (id = public.current_tenant_id() OR public.is_super_admin());
CREATE POLICY "super admin manage tenants" ON public.tenants FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- 9. RLS: profiles
CREATE POLICY "read own profile or same tenant" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR tenant_id = public.current_tenant_id() OR public.is_super_admin());
CREATE POLICY "update own profile" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY "super admin manage profiles" ON public.profiles FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- 10. RLS: user_roles
CREATE POLICY "read own roles or same tenant manager" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_super_admin()
         OR (tenant_id = public.current_tenant_id() AND public.has_tenant_role(public.current_tenant_id(),'manager')));
CREATE POLICY "super admin manage roles" ON public.user_roles FOR ALL TO authenticated
  USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- 11. CUSTOMERS
CREATE TABLE public.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  pay_account TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE POLICY "tenant read customers" ON public.customers FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());
CREATE POLICY "manager write customers" ON public.customers FOR ALL TO authenticated
  USING (public.has_tenant_role(tenant_id,'manager') OR public.is_super_admin())
  WITH CHECK (public.has_tenant_role(tenant_id,'manager') OR public.is_super_admin());

-- 12. WATER_READINGS
CREATE TABLE public.water_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  meter_number TEXT NOT NULL,
  previous NUMERIC NOT NULL DEFAULT 0,
  current_reading NUMERIC NOT NULL,
  consumption NUMERIC NOT NULL DEFAULT 0,
  photo_url TEXT,
  lat NUMERIC,
  lng NUMERIC,
  flag TEXT NOT NULL DEFAULT 'ok',
  status TEXT NOT NULL DEFAULT 'pending',
  reader_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.water_readings TO authenticated;
GRANT ALL ON public.water_readings TO service_role;
ALTER TABLE public.water_readings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant read readings" ON public.water_readings FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());
CREATE POLICY "reader/manager insert readings" ON public.water_readings FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = public.current_tenant_id() AND (
      public.has_tenant_role(tenant_id,'reader')
      OR public.has_tenant_role(tenant_id,'manager')
      OR public.is_super_admin()
    )
  );
CREATE POLICY "manager update readings" ON public.water_readings FOR UPDATE TO authenticated
  USING (public.has_tenant_role(tenant_id,'manager') OR public.is_super_admin())
  WITH CHECK (public.has_tenant_role(tenant_id,'manager') OR public.is_super_admin());
CREATE POLICY "manager delete readings" ON public.water_readings FOR DELETE TO authenticated
  USING (public.has_tenant_role(tenant_id,'manager') OR public.is_super_admin());

-- 13. WATER_BILLS
CREATE TABLE public.water_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  reading_id UUID REFERENCES public.water_readings(id) ON DELETE SET NULL,
  subtotal NUMERIC NOT NULL DEFAULT 0,
  arrears NUMERIC NOT NULL DEFAULT 0,
  total NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.water_bills TO authenticated;
GRANT ALL ON public.water_bills TO service_role;
ALTER TABLE public.water_bills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant read bills" ON public.water_bills FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());
CREATE POLICY "manager/collector write bills" ON public.water_bills FOR ALL TO authenticated
  USING (
    (tenant_id = public.current_tenant_id() AND (
       public.has_tenant_role(tenant_id,'manager') OR public.has_tenant_role(tenant_id,'collector')))
    OR public.is_super_admin()
  )
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND (
       public.has_tenant_role(tenant_id,'manager') OR public.has_tenant_role(tenant_id,'collector')))
    OR public.is_super_admin()
  );

-- 14. PAYMENTS
CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES public.water_bills(id) ON DELETE CASCADE,
  amount NUMERIC NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  status TEXT NOT NULL DEFAULT 'approved',
  collector_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant read payments" ON public.payments FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());
CREATE POLICY "collector/manager write payments" ON public.payments FOR ALL TO authenticated
  USING (
    (tenant_id = public.current_tenant_id() AND (
       public.has_tenant_role(tenant_id,'collector') OR public.has_tenant_role(tenant_id,'manager')))
    OR public.is_super_admin()
  )
  WITH CHECK (
    (tenant_id = public.current_tenant_id() AND (
       public.has_tenant_role(tenant_id,'collector') OR public.has_tenant_role(tenant_id,'manager')))
    OR public.is_super_admin()
  );

-- 15. AUDIT_LOGS
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant read audit" ON public.audit_logs FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());
CREATE POLICY "tenant insert audit" ON public.audit_logs FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.current_tenant_id() OR public.is_super_admin());

-- 16. Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.water_readings;
ALTER PUBLICATION supabase_realtime ADD TABLE public.water_bills;
ALTER PUBLICATION supabase_realtime ADD TABLE public.payments;
ALTER PUBLICATION supabase_realtime ADD TABLE public.tenants;
