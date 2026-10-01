import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { requirePermission } from "@/lib/api/require-permission";
import { allowedClientIds, restrictClientFilter, resolveOrchClientId } from "@/lib/auth/client-access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Owners/admins share one pool of views, so they may edit or delete ANY view; everyone else
// only their own. Runs on the pool (bypasses RLS) with that condition applied explicitly.
function scope(user: { id: string; role: string | null }): { cond: string; params: string[] } {
  const shared = user.role === "owner" || user.role === "admin";
  return shared ? { cond: "", params: [] } : { cond: "and user_id = $2", params: [user.id] };
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePermission("views");
  if (!gate.ok) return gate.response;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const s = scope(gate.user);
  const { rowCount } = await getPool().query(`delete from saved_lists where id = $1 ${s.cond}`, [id, ...s.params]);
  if (!rowCount) return NextResponse.json({ error: "not found" }, { status: 404 });
  // across-all-views totals just lost a member (B4)
  void getPool().query("select fn_refresh_saved_list_counts('{}'::uuid[])").catch(() => {});
  return NextResponse.json({ ok: true });
}

// Update a saved view's name, filters and/or client attachment.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePermission("views");
  if (!gate.ok) return gate.response;
  if (!UUID.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (typeof body?.name === "string" && body.name.trim()) {
    vals.push(body.name.trim());
    sets.push(`name = $${vals.length}`);
  }
  if (body?.filters !== undefined) {
    const filters = restrictClientFilter(body.filters as Record<string, unknown>, await allowedClientIds(gate.user));
    vals.push(JSON.stringify(filters));
    sets.push(`filters = $${vals.length}::jsonb`);
  }
  // 0125: client attachment — body key present means "set it" (null detaches)
  if ("orchClientId" in (body ?? {})) {
    const orchClientId = await resolveOrchClientId(body.orchClientId, gate.user);
    if (orchClientId instanceof NextResponse) return orchClientId;
    vals.push(orchClientId);
    sets.push(`orch_client_id = $${vals.length}::uuid`);
  }
  if (sets.length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const s = scope(gate.user);
  vals.push(id);
  const idPos = vals.length;
  if (s.params.length) vals.push(...s.params);
  const cond = s.cond ? s.cond.replace("$2", `$${idPos + 1}`) : "";
  const { rowCount } = await getPool().query(
    `update saved_lists set ${sets.join(", ")} where id = $${idPos} ${cond}`,
    vals
  );
  if (!rowCount) return NextResponse.json({ error: "not found" }, { status: 404 });
  // recount in the background if the membership definition changed (B4)
  if (body?.filters !== undefined) {
    void getPool().query("select fn_refresh_saved_list_counts($1::uuid[])", [[id]]).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
