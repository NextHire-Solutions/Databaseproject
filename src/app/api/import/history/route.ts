import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { requirePermission } from "@/lib/api/require-permission";

// Recent scraper ingests + current data totals, for the Import page.
export async function GET() {
  const gate = await requirePermission("import");
  if (!gate.ok) return gate.response;

  const pool = getPool();
  const { rows } = await pool.query(
    "select id, performed_by, details, created_at from audit_logs where action = 'ingest' order by created_at desc limit 100"
  );
  const counts = await pool.query(
    "select (select count(*) from agents)::int agents, (select count(*) from offices)::int offices, (select count(*) from mls)::int mls"
  );
  return NextResponse.json({ rows, counts: counts.rows[0] });
}
