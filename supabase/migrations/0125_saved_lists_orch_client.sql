-- 0125 — attach a saved view to a client.
--
-- Until now a view belonged to a client only by what it was called ("Chucktown - Charleston,
-- SC"), the same name-only coupling campaigns had before 0122 stamped them. This is the formal
-- link: nullable, because ~40% of views are deliberately client-less (whole-market prospecting
-- lists, templates, "cvr"). NULL is a legitimate permanent state, not a gap to chase.
--
-- on delete set null: deleting a client must never delete or break the view — it just becomes
-- unattached again.
--
-- The market is NOT a second column here: a view's market already lives in its own filters
-- (MLS / location selections), and a copy of it on the row would only drift.
--
-- Backfilled once from view names with the same discipline as the 0122 campaign stamping:
-- exact or longest-prefix match against orch_clients.client_name, ambiguity left NULL, never
-- guessed. Thereafter the save dialog sets it.

alter table saved_lists
  add column if not exists orch_client_id uuid references orch_clients(id) on delete set null;

create index if not exists idx_saved_lists_orch_client
  on saved_lists (orch_client_id) where orch_client_id is not null;
