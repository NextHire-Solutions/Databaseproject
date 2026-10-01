import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api/require-permission";
import { allowedClientIds, restrictClientFilter, resolveOrchClientId } from "@/lib/auth/client-access";

// Saved views (quick-filters).
// B4: each row carries its cached agent count (cached_count/cached_at — refreshed on
// save/edit, after imports, and by the 6-hourly sync); `totals` adds the across-all-views
// numbers (union = unique agents in at least one view; sum double-counts overlaps).
//
// Visibility: owners and admins share ONE pool of views — they all see the same list,
// whoever created it (CO-69 follow-up: Eddy's owner account opened an empty panel because
// every view belonged to the first admin account). Everyone else sees only their own, so a
// contractor never sees the operators' client-named views.
export async function GET() {
  const gate = await requirePermission("views");
  if (!gate.ok) return gate.response;
  const shared = gate.user.role === "owner" || gate.user.role === "admin";
  const pool = getPool();
  const { rows: data } = await pool.query(
    `select id, name, filters, mode, source_mode, created_at, cached_count, cached_at, orch_client_id
       from saved_lists
      ${shared ? "" : "where user_id = $1"}
      order by created_at desc`,
    shared ? [] : [gate.user.id]
  );
  // 0125: resolve the attached client's name (orch_clients has no RLS grants for app users,
  // so this stays on the pool).
  const clientIds = [...new Set(data.map((l) => l.orch_client_id).filter(Boolean))];
  const names = clientIds.length
    ? (await pool.query("select id, client_name from orch_clients where id = any($1::uuid[])", [clientIds])).rows
    : [];
  const nameById = new Map(names.map((r) => [String(r.id), r.client_name as string | null]));
  const lists = data.map((l) => ({
    ...l,
    client_name: l.orch_client_id ? (nameById.get(String(l.orch_client_id)) ?? null) : null,
  }));
  const totals = (await pool.query("select union_count, sum_count, refreshed_at from saved_list_totals where id = 1")).rows[0] ?? null;
  return NextResponse.json({ lists, totals });
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("views");
  if (!gate.ok) return gate.response;
  const supabase = await createClient();

  const body = await req.json().catch(() => ({}));
  const name: string = (body?.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  // 0125: optional client attachment — must be a real client, and one the caller may see
  const orchClientId = await resolveOrchClientId(body?.orchClientId, gate.user);
  if (orchClientId instanceof NextResponse) return orchClientId;

  const { data, error } = await supabase
    .from("saved_lists")
    .insert({
      user_id: gate.user.id,
      name,
      filters: restrictClientFilter((body?.filters ?? {}) as Record<string, unknown>, await allowedClientIds(gate.user)),
      mode: body?.mode ?? "agent",
      source_mode: body?.source ?? "courted",
      orch_client_id: orchClientId,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // count the new view in the background — the response shouldn't wait on a full search
  void getPool().query("select fn_refresh_saved_list_counts($1::uuid[])", [[data.id]]).catch(() => {});
  return NextResponse.json({ id: data.id });
}
