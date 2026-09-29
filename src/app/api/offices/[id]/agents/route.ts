import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { requirePermission } from "@/lib/api/require-permission";

// Agents that belong to one office (paginated) — for the office profile panel.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("search");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(sp.get("pageSize")) || 50));
  const pool = getPool();

  const office = (
    await pool.query(
      "select id, office_name, brand, office_city, office_state, office_zip, sales_volume, list_side_dollar, buy_side_dollar, units from offices where id = $1",
      [id]
    )
  ).rows[0];
  if (!office) return NextResponse.json({ error: "office not found" }, { status: 404 });

  const total = (await pool.query("select count(*)::int n from agents where office_id = $1", [id])).rows[0].n;
  const { rows } = await pool.query(
    `select id, full_name, license_number, preferred_email, preferred_phone, sales_volume, units, title
       from agents where office_id = $1 order by sales_volume desc nulls last limit $2 offset $3`,
    [id, pageSize, (page - 1) * pageSize]
  );

  return NextResponse.json({ office, agents: rows, total, page, pageSize });
}
