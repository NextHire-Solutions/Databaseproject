import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import { gatherExportRows } from "@/lib/export/gather-rows";

export const maxDuration = 300;

// Export -> Send to campaign (in-house pipeline): queues the filtered (or selected) agents
// as an enrichment batch. The enrich-worker Railway service picks it up, enriches each agent
// (cached results reused), and pushes finished leads into the chosen EmailBison campaign.
// Body: { orchClientId?, clientId?, campaignId?, campaignName?, mode?, source?, filters?, ... }
// orchClientId = orch_clients.id (preferred; the shared client table other apps maintain);
// clientId = legacy clients.id. campaignId = EmailBison numeric id; omit to enrich-only.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { orchClientId = null, clientId = null, campaignId = null, campaignName = null, mode = "agent", source = "courted", filters = {}, selectedIds, rangeFrom, rangeTo } = body ?? {};
  // which source's values win for the merged lead fields (courted | zillow | realtor)
  const sourcePriority = ["courted", "zillow", "realtor"].includes(body?.sourcePriority) ? body.sourcePriority : "courted";

  // Target campaigns: the new multi-select sends campaigns: [{ id, name, clientId }] (may span
  // several clients). Fall back to the legacy single campaignId/campaignName. campaign_id stays
  // = the first campaign so the worker's push-stage + progress guards keep working.
  const campaignList: { id: string; name: string | null }[] = (Array.isArray(body?.campaigns) ? body.campaigns : [])
    .map((c: { id?: unknown; name?: unknown }) => ({ id: c?.id != null ? String(c.id) : "", name: (c?.name as string) ?? null }))
    .filter((c: { id: string }) => c.id);
  if (campaignList.length === 0 && campaignId) campaignList.push({ id: String(campaignId), name: campaignName ?? null });
  const campaignIds = campaignList.map((c) => c.id);
  const campaignNamesJoined = campaignList.map((c) => c.name).filter(Boolean).join(", ") || null;
  const firstCampaignId = campaignIds[0] ?? null;

  const orchClientIds: string[] = Array.isArray(body?.orchClientIds) ? body.orchClientIds.filter(Boolean) : [];
  const f = filters as Record<string, unknown>;
  const filterClientIds = Array.isArray(f?.orchClientIds) ? (f.orchClientIds as string[]) : [];
  const orchClientIdForBatch = orchClientId || orchClientIds[0] || filterClientIds[0] || f?.orchClientId || null;

  let rows: Record<string, unknown>[] = [];
  try {
    // randomize: campaign sends sample ACROSS the filtered set rather than taking its
    // highest-volume head (A22 fix). Ignored when specific agents were hand-picked.
    rows = await gatherExportRows({ mode, source, filters, selectedIds, rangeFrom, rangeTo, userId: user?.id ?? null, randomize: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to gather agents" }, { status: 500 });
  }
  const agentIds = [...new Set(rows.map((r) => r.id as string).filter(Boolean))];
  if (agentIds.length === 0) return NextResponse.json({ error: "No agents to send." }, { status: 400 });

  // A22: shuffle the queue order. WHICH agents go is decided above — gatherExportRows now
  // samples across the filtered set instead of returning its highest-volume head, which is
  // the part that was making every campaign skew to top producers. This shuffle is still
  // needed on top of it: the worker claims items in insertion order, and a hand-picked
  // selection arrives in the order the user checked boxes, so without it that order would
  // decide who gets contacted first.
  for (let i = agentIds.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [agentIds[i], agentIds[j]] = [agentIds[j], agentIds[i]];
  }

  const pool = getPool();

  // A5 scoped sends: if the search was MLS-scoped (selected MLSs with near-complete per-MLS
  // stats coverage — the same gate the search engine uses), stamp the scope on the batch so
  // the worker pushes THAT MLS's numbers as the campaign variables.
  let mlsScope: string[] | null = null;
  // #4: an explicit dialog selection outranks the filter-derived scope; both pass the
  // same coverage gate (every chosen MLS must have near-complete per-MLS data).
  const explicitScope = Array.isArray(body?.mlsScope)
    ? (body.mlsScope.filter((x: unknown) => typeof x === "string") as string[])
    : [];
  const mlsInclude = explicitScope.length
    ? explicitScope
    : Array.isArray((f?.mls as { include?: unknown })?.include)
    ? ((f.mls as { include: unknown[] }).include.filter((x) => typeof x === "string") as string[])
    : [];
  if (mlsInclude.length) {
    const gate = await pool.query(
      `select coalesce(bool_and(coalesce(stats_agents, 0)::numeric >= 0.9 * greatest(coalesce(member_agents, 0), 1)), false) as ok
         from mls where id = any($1::uuid[])`,
      [mlsInclude]
    );
    if (gate.rows[0]?.ok) mlsScope = mlsInclude;
  }

  const dbc = await pool.connect();
  let batchId: string;
  try {
    await dbc.query("begin");
    const batch = await dbc.query(
      `insert into enrichment_batches (client_id, orch_client_id, campaign_id, campaign_ids, campaign_name, total, created_by, filters, source_priority, mls_scope)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::uuid[]) returning id`,
      [
        clientId,
        orchClientIdForBatch,
        firstCampaignId,
        campaignIds.length ? campaignIds : null,
        campaignNamesJoined,
        agentIds.length,
        user.id,
        JSON.stringify({ filters, mode, source, selectedCount: Array.isArray(selectedIds) ? selectedIds.length : 0, rangeFrom: rangeFrom ?? null, rangeTo: rangeTo ?? null }),
        sourcePriority,
        mlsScope,
      ]
    );
    batchId = batch.rows[0].id;
    await dbc.query(
      `insert into enrichment_items (batch_id, agent_id)
       select $1, x.agent_id from unnest($2::uuid[]) as x(agent_id)
       on conflict (batch_id, agent_id) do nothing`,
      [batchId, agentIds]
    );
    await dbc.query("commit");
  } catch (e) {
    await dbc.query("rollback").catch(() => {});
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to queue batch" }, { status: 500 });
  } finally {
    dbc.release();
  }

  await logAudit({
    action: "enrichment_send",
    performedBy: user.email ?? null,
    details: `Queued ${agentIds.length} agents for enrichment${campaignNamesJoined ? ` -> ${campaignIds.length} EmailBison campaign${campaignIds.length > 1 ? "s" : ""} (${campaignNamesJoined})` : " (enrich only)"}`,
    meta: { kind: "enrichment_send", batchId, clientId, orchClientId: orchClientIdForBatch, campaignId: firstCampaignId, campaignIds, campaignName: campaignNamesJoined, source },
  });
  return NextResponse.json({ ok: true, batchId, queued: agentIds.length });
}
