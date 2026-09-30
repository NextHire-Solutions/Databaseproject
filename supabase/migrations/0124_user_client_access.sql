-- 0124 — per-user client visibility.
--
-- The owner can limit a manager/viewer account to specific clients. user_profiles.client_access
-- says which regime the account is under ('all' = unrestricted, today's behaviour; 'selected' =
-- only the clients ticked in user_client_access). Owner and admin accounts are always
-- unrestricted regardless of these values — enforced in code (lib/auth/client-access.ts), so a
-- promoted account never has to have its rows cleaned up.
--
-- Fail-closed: 'selected' with zero rows means the account sees NO clients. New manager/viewer
-- invites start in exactly that state (set by /api/admin/invite); the owner then ticks clients.
--
-- Enforced server-side wherever client data surfaces: the client picker/filter, campaign lists,
-- enrichment history, portal sends, "clients using this MLS", and inside saved filter payloads.

alter table user_profiles
  add column if not exists client_access text not null default 'all';

create table if not exists user_client_access (
  user_id        uuid not null references auth.users(id) on delete cascade,
  orch_client_id uuid not null references orch_clients(id) on delete cascade,
  granted_by     uuid,
  granted_at     timestamptz not null default now(),
  primary key (user_id, orch_client_id)
);

-- read path is always "all clients for one user"
create index if not exists idx_uca_user on user_client_access (user_id);

-- Only the service role / pool touches this table; app users have no grants (same posture as
-- the orch_* tables — see the comment in api/orch/clients).
alter table user_client_access enable row level security;
