-- 0121 — fix: one MasterInbox message can belong to SEVERAL agents.
--
-- 0120 made agent_replies unique on (source, external_id), i.e. one row per source message. But
-- the sync matches a message's sender to agents BY EMAIL, and 210 of the replying addresses match
-- more than one agent record (433 agents in total) — almost always genuine duplicate agent rows:
--     parkerquigleyproperties@gmail.com -> Parker Quigley | Parker Quigley | Gary Smith | Quigley Team
--     gynot@email.com                   -> Anthony Giglio | Tony Giglio | Anthony Giglio | Anthony Giglio
--     david.j@kw.com                    -> David Johnson  | David Johnson | David Johnson
-- The insert therefore produced N rows for one external_id, the unique index kept the first and
-- silently dropped the rest, and 224 agents that really did reply were never flagged.
--
-- The natural key is (source, external_id, AGENT) — the same message legitimately records a reply
-- against every agent record holding that address. Idempotency is preserved: re-running still
-- inserts nothing new.
--
-- Note this does not merge the duplicate agents; it only stops them losing their Replied flag.
-- Deduplicating those records is a separate matter.

drop index if exists agent_replies_source_ext_uniq;

create unique index if not exists agent_replies_source_ext_agent_uniq
  on agent_replies (source, external_id, agent_id) where external_id is not null;
