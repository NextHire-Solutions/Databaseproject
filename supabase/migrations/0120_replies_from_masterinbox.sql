-- 0120 — the Replied flag comes from MasterInbox, and can never be erased again.
--
-- THE PROBLEM. "Replied" was derived from the sequencer mirrors (bison_client_leads /
-- instantly_client_leads), which store one row per lead-per-campaign. The sync prunes rows whose
-- campaign no longer exists in the sequencer:
--     delete from bison_client_leads where campaign_id <> all(<live campaigns>)
-- so deleting a campaign in EmailBison/Instantly silently un-flagged everyone who had replied
-- only there, even though the conversation still sat in MasterInbox.
--
-- THE SOURCE. MasterInbox's `messages` table is the durable record: 13,175 inbound messages from
-- 9,210 distinct senders, back to 2026-02-24, and it is not affected by sequencer housekeeping.
-- It is used for exactly ONE question — did this lead reply? Campaign membership, campaign names
-- and bounces are NOT taken from it and keep coming from the sequencer mirrors as before.
--
-- WHY A SNAPSHOT IS BACKFILLED. Measured before building: MasterInbox matches 6,897 agents, of
-- which 2,449 are NOT flagged today (replies the sequencer path lost or never had). But 713
-- agents flagged today have no inbound message in MasterInbox, and they are NOT simply old
-- history — of the 507 with a known reply date, only 68 predate MasterInbox; the rest replied
-- while it was already running (up to 2026-08-24). So MasterInbox has real gaps of its own, and
-- a straight swap would drop those 713. Everything currently flagged is therefore frozen into
-- this table once, as source='legacy_snapshot', and kept.
--
-- Result after this migration: 5,161 flagged today -> ~7,610, and nothing lost.
--
-- APPEND-ONLY. Nothing in the sync ever deletes from agent_replies. A reply is a historical fact;
-- it cannot be un-said by deleting a campaign.

create table if not exists agent_replies (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references agents(id) on delete cascade,
  email        text,                      -- the address that replied (may differ from the agent's current one)
  replied_at   timestamptz,               -- null for legacy snapshot rows where no date was recorded
  provider     text,                      -- 'instantly' | 'emailbison' | null (informational only)
  source       text not null,             -- 'masterinbox' | 'legacy_snapshot'
  external_id  text,                      -- MasterInbox messages.id — makes re-syncing idempotent
  created_at   timestamptz not null default now()
);

-- One row per source message. Legacy snapshot rows carry a synthetic external_id so the same
-- agent can hold both a snapshot row and real MasterInbox rows without colliding.
create unique index if not exists agent_replies_source_ext_uniq
  on agent_replies (source, external_id) where external_id is not null;
create index if not exists agent_replies_agent_idx on agent_replies (agent_id);
create index if not exists agent_replies_replied_at_idx on agent_replies (replied_at desc nulls last);

-- ---------------------------------------------------------------------------
-- Freeze what we have today, so the 713 MasterInbox lacks are not lost.
-- Runs once; the unique index makes a re-run a no-op.
-- ---------------------------------------------------------------------------
insert into agent_replies (agent_id, email, replied_at, provider, source, external_id)
select a.id,
       coalesce(a.preferred_email, a.enriched_email),
       (select max(i.last_reply_at) from instantly_client_leads i
         where i.agent_id = a.id and i.replied),        -- only Instantly recorded a reply date
       null,
       'legacy_snapshot',
       'snapshot:' || a.id::text
  from agents a
 where a.id in (select agent_id from v_replied_agents)
on conflict (source, external_id) where external_id is not null do nothing;

-- ---------------------------------------------------------------------------
-- The Replied flag now reads ONLY from agent_replies. The sequencer mirrors keep serving
-- campaign membership (v_agent_campaigns) and bounces (v_bounced_agents) untouched.
-- ---------------------------------------------------------------------------
create or replace view v_replied_agents as
  select distinct agent_id from agent_replies where agent_id is not null;

-- The agent grid's "reply source / campaign" detail stays on the sequencer mirrors, because
-- MasterInbox is deliberately not used for campaign attribution. An agent whose reply exists
-- only in MasterInbox shows as replied with no campaign named, which is honest: we know they
-- replied, we are not claiming to know where.
-- (v_agent_reply_sources is intentionally left as-is.)
