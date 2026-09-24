import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import { upsertAgentRows } from "@/lib/ingest/upsert-agents";
import { logAudit } from "@/lib/api/log-audit";
import { isChurned } from "@/lib/clients/lifecycle";

export const maxDuration = 300;

// Manual CSV import from the Import page. Session-authed (unlike the token-authed scraper
// webhook) but feeds the SAME upsert pipeline — match waterfall, per-source stats, office
// aggregates, MLS junctions, and the city/county triggers all apply identically.
// Body: { source?: 'courted'|'zillow'|'realtor', rows: Row[], fileName?, chunk?, chunks?,
//         orchClientId? } — when orchClientId is set, every imported agent (new or matched)
// is also added to that client's lead list (orch_client_leads), which is what the Client
// filter queries.
const MAX_ROWS = 2000;

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const source = ["courted", "zillow", "realtor"].includes(body?.source) ? (body.source as string) : "courted";
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (rows.length === 0) return NextResponse.json({ error: "expected { rows: [...] }" }, { status: 400 });
  if (rows.length > MAX_ROWS) return NextResponse.json({ error: `max ${MAX_ROWS} rows per request` }, { status: 413 });

  const fileName = typeof body?.fileName === "string" ? body.fileName.slice(0, 120) : null;
  const chunkInfo = body?.chunk && body?.chunks ? ` (chunk ${body.chunk}/${body.chunks})` : "";

  // optional client to attach the imported agents to
  const orchClientId = typeof body?.orchClientId === "string" && body.orchClientId ? body.orchClientId : null;
  let clientName: string | null = null;
  if (orchClientId) {
    const c = (await getPool().query(`select client_name from orch_clients where id = $1`, [orchClientId])).rows[0];
    if (!c) return NextResponse.json({ error: "client not found" }, { status: 400 });
    clientName = c.client_name;

    /*
     * A churned client gets no new leads.
     *
     * This is the ONLY place anything writes orch_client_leads, so it is the
     * whole enforcement point rather than one of several. Refusing here also
     * means the rule cannot be bypassed by driving the endpoint directly,
     * which a filtered dropdown would not have prevented.
     *
     * The agents themselves are NOT rejected: only the link to this client is
     * refused. Whoever imported the file can still attach it to a live client.
     *
     * `isChurned` is false whenever the OS feed cannot be read, so a feed
     * outage never blocks an import -- see lib/clients/lifecycle.ts.
     */
    if (await isChurned(clientName)) {
      return NextResponse.json(
        {
          error: `"${clientName}" has churned, so new leads are not built for it. Pick a live client, or reactivate this one in the OS first.`,
        },
        { status: 409 }
      );
    }
  }

  const client = await getPool().connect();
  try {
    const { agentIds, ...result } = await upsertAgentRows(client, rows, source);
    let linked = 0;
    if (orchClientId && agentIds.length) {
      const r = await client.query(
        `insert into orch_client_leads (client_id, agent_id)
         select $1, x from unnest($2::uuid[]) x
         on conflict (client_id, agent_id) do nothing`,
        [orchClientId, agentIds]
      );
      linked = r.rowCount ?? 0;
    }
    await logAudit({
      action: "ingest",
      performedBy: user.email ?? null,
      details: `CSV import${fileName ? ` "${fileName}"` : ""}${chunkInfo} — ${source}: received ${rows.length} — ${JSON.stringify(result)}${clientName ? ` — linked ${linked} to ${clientName}` : ""}`,
      meta: { kind: "csv_import", fileName, source, received: rows.length, orchClientId, linked, ...result },
    });
    getPool().query("select fn_refresh_location_options(false)").catch(() => {}); // debounced dropdown refresh
    getPool()
      .query(
        `select fn_refresh_saved_list_counts() where exists
           -- 1 hour, matching api/ingest/agents: re-counting all saved lists costs ~9.8 s and this
           -- fires on every import batch, so a 10-minute window kept it running all day.
           (select 1 from saved_lists where cached_at is null or cached_at < now() - interval '1 hour')`
      )
      .catch(() => {}); // B4: recount saved views, 10-min debounce
    return NextResponse.json({ ok: true, source, received: rows.length, linked, client: clientName, ...result });
  } catch (e) {
    console.error("csv import error:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "import failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
