create table if not exists public.admin_recovery_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_digest text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now()
);

alter table public.admin_recovery_tokens enable row level security;

create index if not exists admin_recovery_tokens_active_idx
  on public.admin_recovery_tokens (user_id, expires_at)
  where used_at is null;

create or replace function public.claim_owner_recovery_token(p_token_digest text)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user uuid;
begin
  update public.admin_recovery_tokens
     set used_at = now()
   where token_digest = p_token_digest
     and used_at is null
     and expires_at > now()
  returning user_id into v_user;

  if v_user is null then
    raise exception 'invalid or expired recovery token';
  end if;

  if v_user <> 'e8c3c3ad-1404-444b-8096-59770a15a82e'::uuid then
    raise exception 'recovery target not allowed';
  end if;

  return v_user;
end;
$function$;

revoke all on function public.claim_owner_recovery_token(text) from public, anon, authenticated;
grant execute on function public.claim_owner_recovery_token(text) to service_role;

revoke all on table public.admin_recovery_tokens from public, anon, authenticated;
