import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// Per-lead enrichment detail for one batch — feeds the Export page's Clay-style drill-down:
// lead name, the email the pipeline found, its verification status/provider, the final
// outcome, and the full step_log trail (each find/verify step with ok/ms/note) as the
// verification result payload.
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const batchId = req.nextUrl.searchParams.get("batchId") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId)) {
    return NextResponse.json({ error: "bad batchId" }, { status: 400 });
  }

  // A batch tops out in the low thousands; the 10k cap keeps a runaway payload impossible.
  const { rows } = await getPool().query(
    `select i.id, a.full_name, i.email, i.email_status, i.provider, i.status, i.error,
            i.attempts, i.step_log, i.updated_at
       from enrichment_items i
       left join agents a on a.id = i.agent_id
      where i.batch_id = $1
      order by a.full_name nulls last
      limit 10000`,
    [batchId]
  );
  return NextResponse.json({ items: rows });
}
