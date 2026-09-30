import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { makeCampaignMatcher } from "@/lib/bison/match-campaign";
import { requirePermission } from "@/lib/api/require-permission";
import { allowedClientIds } from "@/lib/auth/client-access";

// Campaigns for one or more clients. All clients share one EmailBison workspace, so campaigns
// are associated by NAME ("Client Name + Sender + Market") using the SHARED matcher in
// @/lib/bison/match-campaign — the same one the 6-hourly sync uses to attribute leads.
//
// This route used to do its own strict SQL matching, which disagreed with the sync: campaigns
// whose leads the sync had attributed to a client did not appear in this list, so an operator
// could not send to them. 13 clients were affected, 47 campaigns invisible, 72,407 leads behind
// them — Jeff Cook Real Estate had 13 campaigns and an empty dropdown. See the module for the
// shapes that were missed (numbered variants, "Copy of ...", leading "The", punctuation).
//
// Params (any one):
//   orchClientIds=id1,id2  — preferred; multi-select. Campaigns come back tagged per client.
//   orchClientId=id        — single orch client (back-compat).
//   clientId=id            — legacy clients.id (single).
// Response: { campaigns: [{ id, bison_campaign_id, bison_id, name, status, is_default,
//                           client_id, client_name }] }
export async function GET(req: NextRequest) {
  const gate = await requirePermission("campaign.send", "clients");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const orchClientIds = (url.searchParams.get("orchClientIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const orchClientId = url.searchParams.get("orchClientId");
  const clientId = url.searchParams.get("clientId");
  if (orchClientId && !orchClientIds.includes(orchClientId)) orchClientIds.push(orchClientId);

  // 0124: a client-restricted account may only ask about its allowed clients. Off-limits ids
  // are dropped (so the response simply has no campaigns for them), and the legacy clients.id
  // path is refused outright — it bypasses the orch client list the restriction is defined on.
  const allowed = await allowedClientIds(gate.user);
  let requested = orchClientIds;
  if (allowed !== null) {
    const ok = new Set(allowed);
    requested = orchClientIds.filter((id) => ok.has(id));
    if (clientId) return NextResponse.json({ error: "Not available for this account." }, { status: 403 });
  }

  const pool = getPool();

  // Which clients did the caller ask for?
  let wanted: { id: string; client_name: string | null; bison_campaign_id: string | null }[] = [];
  if (requested.length) {
    wanted = (
      await pool.query(
        "select id, client_name, bison_campaign_id from orch_clients where id = any($1::uuid[])",
        [requested]
      )
    ).rows;
  } else if (clientId) {
    const c = (await pool.query("select id, name as client_name from clients where id = $1", [clientId])).rows[0];
    if (c) wanted = [{ id: c.id, client_name: c.client_name, bison_campaign_id: null }];
  }
  if (wanted.length === 0) return NextResponse.json({ campaigns: [] });

  // The matcher needs EVERY client, not just the requested ones: ties are only detectable
  // against the full set, and without them an ambiguous campaign would look unambiguous and get
  // filed under whichever client happened to be asked for.
  const allClients = (
    await pool.query(
      "select id, client_name, bison_campaign_id from orch_clients where client_name is not null"
    )
  ).rows as { id: string; client_name: string | null; bison_campaign_id: string | null }[];
  const matchCampaign = makeCampaignMatcher(allClients);

  // 124 campaigns total — matching in memory is cheaper than a query per client, and it is the
  // only way to run exactly the same code path as the sync.
  const campaigns = (
    await pool.query(
      `select id, bison_campaign_id, coalesce(raw->>'id', bison_campaign_id) as bison_id, name, status
         from bison_campaigns order by name`
    )
  ).rows as { id: string; bison_campaign_id: string; bison_id: string; name: string; status: string }[];

  const wantedById = new Map(wanted.map((c) => [c.id, c]));
  const out = campaigns.flatMap((bc) => {
    const owner = matchCampaign(bc.name, bc.bison_id);
    if (!owner || !wantedById.has(owner.id)) return [];
    const w = wantedById.get(owner.id)!;
    return [
      {
        ...bc,
        is_default: !!w.bison_campaign_id && bc.bison_id === w.bison_campaign_id,
        client_id: w.id,
        client_name: w.client_name,
      },
    ];
  });

  return NextResponse.json({ campaigns: out });
}
