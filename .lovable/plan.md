## Goal
Grant `super_admin` in `user_roles` to the username **mofeed2020** so the owner dashboard, subscription guard, and tenant activation RPCs all recognise you as the platform owner.

## Why a plain INSERT is not enough
`public.user_roles.user_id` is a foreign key to `auth.users(id)`. The current login screen is offline-only (username + demo password `1234`, stored in Zustand) and never creates a Supabase auth user, so:
- `auth.users` is empty (confirmed by query).
- No `user_id` exists to insert into `user_roles`.
- `/super-admin`, `activate_tenant` RPC, and every RLS policy that calls `has_role(auth.uid(), 'super_admin')` will keep failing until a real signed-in session exists.

We need to (a) create a real auth user tied to the username `mofeed2020`, (b) insert its `user_roles` row as `super_admin`, and (c) make the existing username login actually sign that user into Supabase so `auth.uid()` is populated.

## Plan

### 1. Migration — seed the super_admin
Runs inside a single security-definer block so we can call Supabase's admin API paths via SQL:

```sql
-- Create the auth user for username "mofeed2020" if missing.
-- We map username -> deterministic email so the demo login can sign in.
DO $$
DECLARE
  v_email text := 'mofeed2020@mizan.local';
  v_uid uuid;
BEGIN
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email;

  IF v_uid IS NULL THEN
    v_uid := extensions.uuid_generate_v4();
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
      (extensions.uuid_generate_v4(), v_uid, v_uid::text,
       jsonb_build_object('sub', v_uid::text, 'email', v_email),
       'email', now(), now(), now());
  END IF;

  -- Ensure profile row exists (trigger handle_new_user also does this).
  INSERT INTO public.profiles (id, display_name)
  VALUES (v_uid, 'mofeed2020')
  ON CONFLICT (id) DO NOTHING;

  -- Grant super_admin (tenant_id NULL is fine for platform-wide role).
  INSERT INTO public.user_roles (user_id, role)
  VALUES (v_uid, 'super_admin')
  ON CONFLICT (user_id, role) DO NOTHING;
END $$;
```

Notes:
- Writes to the `auth` schema are normally off-limits, but a one-shot seed is the only way to create the account without a Supabase Dashboard. If the migration is rejected on that basis, the fallback is: you sign up once through a temporary email/password screen, then re-run only the last two INSERTs against your real `auth.uid()`.
- Password is hashed with `crypt(... 'bf')` so `signInWithPassword` accepts `1234`.

### 2. Wire the demo login to Supabase (code — after migration approval)
Small change in `src/lib/auth.ts` so the username field actually establishes a Supabase session (required for `auth.uid()` in RLS):
- In `login(name, role, password)`, after the local checks succeed, also call `supabase.auth.signInWithPassword({ email: `${name}@mizan.local`, password })`.
- If that call succeeds, call `hydrateFromSupabase()` so `isSuperAdmin` gets populated from `user_roles`.
- If it fails (unknown username), keep the current offline behaviour so meter readers in low-connectivity zones still work.

### 3. Re-enable the `/super-admin` gate
`src/routes/super-admin/index.tsx` currently short-circuits to `setAllowed(true)` (the temporary bypass we added earlier). Restore the real check: allow only when `useAuth().user.isSuperAdmin === true`.

## Verification after run
1. Log in with username `mofeed2020` / password `1234`.
2. Open `/super-admin` — dashboard loads (no redirect).
3. `SELECT role FROM public.user_roles WHERE user_id = auth.uid();` returns `super_admin`.
4. Activate a tenant from `/subscription` — `activate_tenant` RPC succeeds.

## Out of scope
- No changes to `src/lib/ai-intent.ts` or `src/routes/assistant.tsx`.
- No changes to tenant/water tables or their RLS policies.
