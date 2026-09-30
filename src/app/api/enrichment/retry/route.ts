import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import { requirePermission } from "@/lib/api/require-permission";
import { allowedClientIds } from "@/lib/auth/client-access";

// Re-queue ONLY the failed items of an enrichment batch. Items that already have an email
// go back to 'enriched' (straight to the push stage — never re-enriched, never re-paid);
// items that failed during enrichment go back to 'pending'. Successes are never re-sent.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("campaign.send");
  if (!gate.ok) return gate.response;

  const body = await req.json().catch(() => ({}));
  const batchId: string = body?.batchId ?? "";
  if (!batchId) return NextResponse.json({ error: "batchId required" }, { status: 400 });

  const pool = getPool();

  // 0124: a client-restricted account may only retry batches of its allowed clients.
  const allowed = await allowedClientIds(gate.user);
  if (allowed !== null) {
    const { rows: b } = await pool.query(`select orch_client_id from enrichment_batches where id = $1`, [batchId]);
    const ownerId = b[0]?.orch_client_id as string | null | undefined;
    if (!ownerId || !allowed.includes(ownerId)) {
      return NextResponse.json({ error: "You don't have access to this batch." }, { status: 403 });
    }
  }

  const { rows } = await pool.query(
    `update enrichment_items
        set status = case when email is not null then 'enriched' else 'pending' end,
            attempts = 0, error = null, claimed_at = null, claim_token = null, updated_at = now()
      where batch_id = $1 and status = 'failed'
      returning id`,
    [batchId]
  );
  if (rows.length > 0) {
    await pool.query(
      `update enrichment_batches set status = 'running', finished_at = null where id = $1`,
      [batchId]
    );
    await logAudit({
      action: "enrichment_retry",
      performedBy: gate.user.email ?? null,
      details: `Re-queued ${rows.length} failed items of enrichment batch ${batchId}`,
      meta: { kind: "enrichment_retry", batchId, retried: rows.length },
    });
  }
  return NextResponse.json({ ok: true, retried: rows.length });
}
