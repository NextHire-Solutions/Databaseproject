-- 0122: give a campaign a usable link to the client it belongs to.
--
-- THE PROBLEM
--
-- `bison_campaigns.client_id` has existed since 0008 and carries an index, and
-- in production it is populated on 0 of 256 rows. It is not neglect: the column
-- is a foreign key to `clients`, which holds TWO rows — "Test Client" and
-- "New Test Client" — and exists to carry the EmailBison workspace key. The
-- real clients are the orchestrator's 43 rows in `orch_clients`.
--
-- So the column could never hold a real client, and every campaign-to-client
-- association has been recomputed from the campaign NAME on every sync and then
-- thrown away. That is what the architecture spec means in §19's Campaigns band
-- ("resolve, but by name more than by ID") and §14 item 12.
--
-- THE CHANGE
--
-- One nullable column pointing at the right table, plus its index. Nothing is
-- dropped: `client_id` stays exactly as it is, still referencing `clients`, so
-- anything relying on it is untouched. Nothing is backfilled here either — the
-- six-hourly sync stamps it using the SAME matcher it already runs for leads,
-- so the value is always the matcher's own answer rather than a second opinion
-- frozen at migration time.
--
-- ON DELETE SET NULL rather than CASCADE: a client being removed must never
-- take campaign history with it. §9 is explicit that campaign history survives,
-- because that is what makes reactivation possible.
--
-- ADDITIVE AND REVERSIBLE. Adds one nullable column and one index. Touches no
-- existing row, no existing column, and nothing any tool reads today. Dropping
-- it would lose only the recorded links, which the next sync recreates.
--
-- SAFE TO RE-RUN.

BEGIN;

ALTER TABLE public.bison_campaigns
  ADD COLUMN IF NOT EXISTS orch_client_id UUID
  REFERENCES public.orch_clients(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.bison_campaigns.orch_client_id IS
  'The client this campaign belongs to, as recorded by the sync''s matcher. '
  'NULL means the matcher found no client — an internal or template campaign, '
  'or a name it cannot resolve. Distinct from client_id, which references the '
  'two-row `clients` table that carries the EmailBison workspace key.';

CREATE INDEX IF NOT EXISTS idx_bison_campaigns_orch_client
  ON public.bison_campaigns(orch_client_id);

COMMIT;
