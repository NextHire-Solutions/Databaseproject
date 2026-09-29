import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { requirePermission } from "@/lib/api/require-permission";

// Recent enrichment batches with live counters — feeds the Admin -> Activity progress panel.
export async function GET() {
  const gate = await requirePermission("export");
  if (!gate.ok) return gate.response;

  const { rows } = await getPool().query(
    `select b.id, b.status, b.campaign_id, b.campaign_name, b.total, b.enriched, b.no_email,
            b.sent, b.failed, b.skipped, b.created_at, b.finished_at, b.filters,
            coalesce(oc.client_name, c.name) as client_name,
            up.email as performed_by
       from enrichment_batches b
       left join clients c on c.id = b.client_id
       left join orch_clients oc on oc.id = b.orch_client_id
       left join user_profiles up on up.id = b.created_by
      order by b.created_at desc
      limit 50`
  );
  return NextResponse.json({ batches: rows });
}
