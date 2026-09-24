-- One-time owner recovery bootstrap token.
-- Store only a SHA-256 digest; the raw token is delivered out-of-band once.
insert into public.admin_recovery_tokens (
  user_id,
  token_digest,
  expires_at
)
select
  'e8c3c3ad-1404-444b-8096-59770a15a82e'::uuid,
  'd51f2078290fa0e31612284f7789eee1315056545c7ef06fe9d31a4ff826f1f3',
  now() + interval '24 hours'
where not exists (
  select 1
  from public.admin_recovery_tokens
  where token_digest = 'd51f2078290fa0e31612284f7789eee1315056545c7ef06fe9d31a4ff826f1f3'
);
