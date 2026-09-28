-- 0123 — per-client campaign stats, in one call, for the OS's Database view.
--
-- The architecture document's §8 lists the Database view's fields, including
-- "Sequencers", "Replies" and "Bounces". This app computes them on its Clients
-- page (/webhooks) with correlated subqueries over v_client_campaign_leads —
-- 438,479 rows on 28 Sep 2026 — through a direct Postgres connection.
--
-- The OS is taking over this view (the standalone apps are being retired) and
-- reaches this database through PostgREST, which caps a read at 1,000 rows. Paging
-- the view would be ~440 requests per page load. This function performs the SAME
-- aggregation as src/app/api/orch/clients/route.ts, in the database, and returns
-- one row per client.
--
-- READ ONLY: a STABLE SQL function with no side effects. It adds nothing to any
-- table and changes no existing object. Safe to re-run.

BEGIN;

CREATE OR REPLACE FUNCTION public.os_client_campaign_stats()
RETURNS TABLE (
  client_id      uuid,
  leads          integer,   -- agents built for the client (orch_client_leads)
  in_sequencers  integer,   -- distinct lead emails inside EmailBison / Instantly campaigns
  matched        integer,   -- of those, matched to an agent record
  replied        integer,   -- distinct lead emails that replied
  bounced        integer,   -- distinct lead emails that bounced
  campaigns      jsonb      -- [{id, name, provider}] of every campaign holding its leads
)
LANGUAGE sql
STABLE
AS $$
  -- The same correlated subqueries as api/orch/clients, one row per client.
  SELECT
    c.id,
    (SELECT count(*) FROM public.orch_client_leads l WHERE l.client_id = c.id)::int,
    (SELECT count(DISTINCT b.email) FROM public.v_client_campaign_leads b WHERE b.client_id = c.id)::int,
    (SELECT count(DISTINCT b.agent_id) FROM public.v_client_campaign_leads b WHERE b.client_id = c.id AND b.agent_id IS NOT NULL)::int,
    (SELECT count(DISTINCT b.email) FROM public.v_client_campaign_leads b WHERE b.client_id = c.id AND b.replied)::int,
    (SELECT count(DISTINCT b.email) FROM public.v_client_campaign_leads b WHERE b.client_id = c.id AND b.bounced)::int,
    -- Instantly campaigns are known only through their leads (there is no
    -- instantly_campaigns table), so the list comes from the same view.
    (SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object(
              'id', b.campaign_id::text, 'name', b.campaign_name, 'provider', b.provider)), '[]'::jsonb)
       FROM public.v_client_campaign_leads b WHERE b.client_id = c.id)
  FROM public.orch_clients c
$$;

COMMENT ON FUNCTION public.os_client_campaign_stats() IS
  'Per-client counts: leads built, leads in sequencers, matched, '
  'replied, bounced, and the campaigns holding them. Same definitions as the Clients page (api/orch/clients). '
  'Read only. Used by the BrokerStaffer OS Database view.';

-- Same exposure as the view it reads: server-side callers only.
REVOKE ALL ON FUNCTION public.os_client_campaign_stats() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.os_client_campaign_stats() TO service_role;

COMMIT;

-- Let the REST API see the new function without waiting for its next reload.
NOTIFY pgrst, 'reload schema';
