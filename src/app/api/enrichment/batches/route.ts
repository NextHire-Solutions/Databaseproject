import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { requirePermission } from "@/lib/api/require-permission";
import { allowedClientIds } from "@/lib/auth/client-access";

// Recent enrichment batches with live counters — feeds the Admin -> Activity progress panel.
export async function GET() {
  const gate = await requirePermission("export");
  if (!gate.ok) return gate.response;

  // 0124: a client-restricted account sees only batches for its allowed clients (their own
  // sends necessarily target an allowed client, so nothing of theirs disappears).
  const allowed = await allowedClientIds(gate.user);
  const { rows } = await getPool().query(
    `select b.id, b.status, b.campaign_id, b.campaign_name, b.total, b.enriched, b.no_email,
            b.sent, b.failed, b.skipped, b.created_at, b.finished_at, b.filters,
            coalesce(oc.client_name, c.name) as client_name,
            up.email as performed_by
       from enrichment_batches b
       left join clients c on c.id = b.client_id
       left join orch_clients oc on oc.id = b.orch_client_id
       left join user_profiles up on up.id = b.created_by
      ${allowed !== null ? "where b.orch_client_id = any($1::uuid[])" : ""}
      order by b.created_at desc
      limit 50`,
    allowed !== null ? [allowed] : []
  );
  return NextResponse.json({ batches: rows });
}
