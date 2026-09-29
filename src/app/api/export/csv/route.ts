import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/api/log-audit";
import { EXPORT_COLUMNS, EXPORT_VALUE, orderedKeys } from "@/lib/export/columns";
import { gatherExportRows } from "@/lib/export/gather-rows";
import { requirePermission } from "@/lib/api/require-permission";

export const maxDuration = 300;

type Row = Record<string, unknown>;

const esc = (v: unknown) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function POST(req: NextRequest) {
  const gate = await requirePermission("export");
  if (!gate.ok) return gate.response;

  const body = await req.json().catch(() => ({}));
  const { mode = "agent", source = "courted", filters = {}, selectedIds, rangeFrom, rangeTo, columns } = body ?? {};
  const keys = orderedKeys(columns);
  const labelByKey = Object.fromEntries(EXPORT_COLUMNS.map((c) => [c.key, c.label]));

  let rows: Row[] = [];
  try {
    rows = (await gatherExportRows({ mode, source, filters, selectedIds, rangeFrom, rangeTo, userId: gate.user.id ?? null })) as Row[];
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to gather agents" }, { status: 500 });
  }

  if (rows.length === 0) return NextResponse.json({ error: "No agents match — nothing to export." }, { status: 400 });

  const header = keys.map((k) => esc(labelByKey[k])).join(",");
  const lines = rows.map((r) => keys.map((k) => esc(EXPORT_VALUE[k]?.(r))).join(","));
  const csv = [header, ...lines].join("\r\n");

  await logAudit({ action: "csv_export", performedBy: gate.user.email ?? null, details: `Exported ${rows.length} agents to CSV (${keys.length} cols)` });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="brokerstaffer-agents.csv"`,
    },
  });
}
