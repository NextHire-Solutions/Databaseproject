import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { requirePermission } from "@/lib/api/require-permission";
import { logAudit } from "@/lib/api/log-audit";

// 0124 — which clients a manager/viewer account can see.
//
// GET  ?userId=…               -> { mode, ids, suggested } (admins can look)
// POST { userId, mode, ids }   -> save                      (only the owner can touch)
//
// `suggested` pre-ticks the checklist from the salesperson assignments that already exist:
// orch_clients.salesperson_id is filled on most clients, and orch_salespeople carries the same
// people by name. A name match is only ever a suggestion — the owner's ticks are what count.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const gate = await requirePermission("admin");
  if (!gate.ok) return gate.response;

  const userId = new URL(req.url).searchParams.get("userId") ?? "";
  if (!UUID.test(userId)) return NextResponse.json({ error: "bad userId" }, { status: 400 });

  const pool = getPool();
  const [profile, access, suggested] = await Promise.all([
    pool.query(`select email, full_name, role, client_access from user_profiles where id = $1`, [userId]),
    pool.query(`select orch_client_id from user_client_access where user_id = $1`, [userId]),
    pool.query(
      `select c.id from orch_clients c
        join orch_salespeople s on s.id = c.salesperson_id
        join user_profiles u on u.id = $1
       where lower(trim(s.name)) = lower(trim(coalesce(u.full_name, '')))`,
      [userId]
    ),
  ]);
  if (!profile.rows[0]) return NextResponse.json({ error: "User not found" }, { status: 404 });

  return NextResponse.json({
    mode: profile.rows[0].client_access === "selected" ? "selected" : "all",
    role: profile.rows[0].role,
    ids: access.rows.map((r) => String(r.orch_client_id)),
    suggested: suggested.rows.map((r) => String(r.id)),
  });
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("admin");
  if (!gate.ok) return gate.response;
  if (gate.user.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can change client access." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const userId = typeof body?.userId === "string" ? body.userId : "";
  const mode = body?.mode === "selected" ? "selected" : body?.mode === "all" ? "all" : null;
  const ids: string[] = (Array.isArray(body?.ids) ? body.ids : []).filter(
    (x: unknown): x is string => typeof x === "string" && UUID.test(x)
  );
  if (!UUID.test(userId) || !mode) return NextResponse.json({ error: "userId and mode required" }, { status: 400 });

  const pool = getPool();
  const { rows: target } = await pool.query(`select email, role from user_profiles where id = $1`, [userId]);
  if (!target[0]) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (["owner", "admin"].includes(target[0].role)) {
    // enforcement ignores the setting for these roles, so refusing beats storing a lie
    return NextResponse.json({ error: "Owner and admin accounts always see all clients." }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`update user_profiles set client_access = $2 where id = $1`, [userId, mode]);
    await client.query(`delete from user_client_access where user_id = $1`, [userId]);
    if (mode === "selected" && ids.length) {
      // insert-select against orch_clients so a stale or made-up id can never be granted
      await client.query(
        `insert into user_client_access (user_id, orch_client_id, granted_by)
         select $1, id, $3 from orch_clients where id = any($2::uuid[])
         on conflict do nothing`,
        [userId, ids, gate.user.id]
      );
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return NextResponse.json({ error: e instanceof Error ? e.message : "save failed" }, { status: 500 });
  } finally {
    client.release();
  }

  const { rows: saved } = await pool.query(`select count(*)::int as n from user_client_access where user_id = $1`, [
    userId,
  ]);
  await logAudit({
    action: "client_access_changed",
    performedBy: gate.user.email,
    details: `${target[0].email}: ${mode === "all" ? "all clients" : `${saved[0]?.n ?? 0} selected clients`}`,
  });
  return NextResponse.json({ ok: true, mode, count: saved[0]?.n ?? 0 });
}
