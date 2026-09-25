import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import { normClientName } from "@/lib/bison/match-campaign";
import { lifecycleKey, loadLifecycle } from "@/lib/clients/lifecycle";

// Orchestrator clients (orch_clients — the source of truth, written by Masterinbox and other
// apps) + how many agents were built for each (orch_client_leads). Feeds the "Client" filter
// dropdown, the Clients page, and the export dialog's client picker.
// ?inReview=1 -> only clients whose leads are up for review (leads_inreview = true) — the
// main-UI Client filter uses this so operators only see clients awaiting review.
// orch_* tables have no RLS grants for app users, so this reads via the pool behind an auth gate.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const inReviewOnly = new URL(req.url).searchParams.get("inReview") === "1";
  const pool = getPool();
  const [{ rows }, sync, bisonTotal] = await Promise.all([
    pool.query(
      // lead_count = orchestrator/scraper list; bison_leads = what's actually in the sequencers
      // (all campaign membership, incl. leads not in our DB); bison_matched = of those, rows we
      // can show in the grid. Once bison_leads > 0 the client filter uses that set (D1).
      //
      // These now count BOTH sequencers via v_agent_campaigns, which is why the page's column
      // headers lost their "(Bison)" qualifier: they were labelled that way only because they
      // disagreed with the agent table, and since 0109 they no longer do. The column ALIASES keep
      // the bison_ prefix so the response shape and every consumer stay unchanged.
      //
      // Counted on email, so a lead in several of a client's campaigns still counts once. Instantly
      // rows with a null client_id belong to no client and correctly fall out of these per-client
      // counts, while still being visible in the agent table.
      `select c.id, c.client_name, c.status, c.mls, c.location, c.bison_campaign_id,
              c.leads_inreview, c.bison_leads_exported, c.created_at,
              (c.portal_url is not null and c.portal_token is not null) as has_portal,
              count(distinct l.agent_id)::int as lead_count,
              (select count(distinct b.email) from v_client_campaign_leads b where b.client_id = c.id)::int as bison_leads,
              (select count(distinct b.agent_id) from v_client_campaign_leads b where b.client_id = c.id and b.agent_id is not null)::int as bison_matched,
              (select count(distinct b.email) from v_client_campaign_leads b where b.client_id = c.id and b.replied)::int as bison_replied,
              (select count(distinct b.email) from v_client_campaign_leads b where b.client_id = c.id and b.bounced)::int as bison_bounced
         from orch_clients c
         left join orch_client_leads l on l.client_id = c.id
        ${inReviewOnly ? "where c.leads_inreview = true" : ""}
        group by c.id
        order by c.client_name nulls last`
    ),
    pool.query(`select max(fetched_at) as at from bison_campaigns`),
    pool.query(`select count(distinct (client_id, email))::int as total, count(distinct agent_id)::int as matched, max(synced_at) as at from v_client_campaign_leads`),
  ]);
  /*
   * The client's LIFECYCLE status, from the OS.
   *
   * §8 lists "Client status" AND "Onboarding status" as two separate fields of
   * the Database view, and until now only the second existed: `c.status` is the
   * PIPELINE stage (new -> ... -> live -> paused), which answers how far through
   * onboarding a client is, not whether they are still a client. §11 calls this
   * out by name -- "especially important in places like the Database ... where
   * we currently have long client lists without sufficient visibility into
   * client status".
   *
   * Null when the feed cannot be read, and the UI shows nothing rather than
   * guessing: an unknown status must never render as "active".
   */
  const lifecycle = await loadLifecycle();
  const clients = rows.map((row: Record<string, unknown>) => ({
    ...row,
    lifecycle: lifecycle?.get(lifecycleKey(String(row.client_name ?? ""))) ?? null,
  }));

  return NextResponse.json({
    clients,
    campaignsSyncedAt: sync.rows[0]?.at ?? null,
    bison: { total: bisonTotal.rows[0]?.total ?? 0, matched: bisonTotal.rows[0]?.matched ?? 0, syncedAt: bisonTotal.rows[0]?.at ?? null },
  });
}

// Manual "Add client" — normally the orchestrator creates clients at onboarding, but a client
// whose campaign already runs in Bison needs a row here before the sync can attach its leads.
// Name-only insert; the campaign matcher picks it up on the next sync. Blocks duplicates under
// the same normalization the matcher uses (case/spacing/punctuation-insensitive).
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = typeof body.client_name === "string" ? body.client_name.trim() : "";
  if (!name) return NextResponse.json({ error: "Client name is required" }, { status: 400 });

  const pool = getPool();
  /*
   * The duplicate check uses THE MATCHER'S normalization, not one of its own.
   *
   * It used to normalize in SQL with regexp_replace(lower(name), '[^a-z0-9]', ''),
   * which is WEAKER than normClientName in two ways: it does not drop "copy of",
   * and it does not drop a leading "the". So the guard would happily accept a
   * name that the campaign matcher then sees as the SAME client:
   *
   *     existing   "The Keyes Company"   matcher -> keyescompany
   *     accepted   "Keyes Company"       matcher -> keyescompany   <- collision
   *
   * Two clients sharing a normalized name is exactly the tie that makeCampaignMatcher
   * refuses to guess on, so it returns null for BOTH -- and the 6-hourly sync
   * silently stops stamping client_id on either one's leads. Measured before this
   * change: all 46 clients were reachable this way ("Copy of <name>" for every one
   * of them, plus the bare form for the three starting with "The"), and 36,586 lead
   * rows sat behind the 18 that have leads. Nothing was broken yet -- no two current
   * names collide -- so this is preventive, and it rejects nothing that exists today.
   *
   * Done in JS against the full list rather than reimplemented in SQL on purpose:
   * orch_clients is 46 rows, and sharing the matcher's own function is the only way
   * the two can never drift apart again. A second copy of the rule is what caused this.
   */
  const { rows: existing } = await pool.query(`select client_name from orch_clients`);
  const incoming = normClientName(name);
  const clash = existing.find(
    (r: { client_name: string | null }) => normClientName(r.client_name ?? "") === incoming
  );
  if (clash) {
    return NextResponse.json({ error: `A client named "${clash.client_name}" already exists` }, { status: 409 });
  }

  const { rows } = await pool.query(
    `insert into orch_clients (client_name, status) values ($1, 'new') returning id, client_name, status, created_at`,
    [name]
  );
  await pool.query(`insert into audit_logs (action, performed_by, details) values ('client_added', $1, $2)`, [
    user.email ?? user.id,
    `Added client "${name}" from the Clients page`,
  ]);
  return NextResponse.json({ client: rows[0] });
}
