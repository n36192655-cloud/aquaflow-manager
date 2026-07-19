DO $$
DECLARE
  v_email text := 'mofeed2020@mizan.local';
  v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email;

  IF v_uid IS NULL THEN
    v_uid := gen_random_uuid();
    INSERT INTO auth.users
      (id, instance_id, aud, role, email, encrypted_password,
       email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
       created_at, updated_at)
    VALUES
      (v_uid, '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', v_email, crypt('1234', gen_salt('bf')),
       now(), '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('display_name','mofeed2020'),
       now(), now());
    INSERT INTO auth.identities
      (id, user_id, provider_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
    VALUES
      (gen_random_uuid(), v_uid, v_uid::text,
       jsonb_build_object('sub', v_uid::text, 'email', v_email),
       'email', now(), now(), now());
  END IF;

  INSERT INTO public.profiles (id, display_name)
  VALUES (v_uid, 'mofeed2020')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_roles (user_id, role)
  SELECT v_uid, 'super_admin'::app_role
  WHERE NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = v_uid AND role = 'super_admin'
  );
END $$;