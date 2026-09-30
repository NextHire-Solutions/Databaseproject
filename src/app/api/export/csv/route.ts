import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/api/log-audit";
import { EXPORT_COLUMNS, EXPORT_VALUE, orderedKeys } from "@/lib/export/columns";
import { gatherExportRows } from "@/lib/export/gather-rows";
import { requirePermission } from "@/lib/api/require-permission";
import { allowedClientIds, restrictClientFilter } from "@/lib/auth/client-access";
import { exportCapFor } from "@/lib/auth/permissions";

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

  // CO-69: capped roles export at most `cap` rows per export. A ranged request keeps its
  // starting point and is shortened to the cap; hand-picked ids beyond it are dropped. Clamped
  // rather than refused — "up to 1000" is what was asked for — and the audit line says so.
  const cap = exportCapFor(gate.user.role);
  let effSelected = selectedIds;
  let effTo = rangeTo;
  let capped = false;
  if (cap) {
    if (Array.isArray(effSelected) && effSelected.length > cap) {
      effSelected = effSelected.slice(0, cap);
      capped = true;
    }
    const from = Number(rangeFrom) > 0 ? Number(rangeFrom) : 1;
    const to = Number(rangeTo) > 0 ? Number(rangeTo) : null;
    if (to === null || to - from + 1 > cap) {
      effTo = from + cap - 1;
      capped = capped || to !== null || true;
    }
  }

  let rows: Row[] = [];
  try {
    // 0124: strip client references the caller isn't allowed before the filter engine sees them
    const effFilters = restrictClientFilter(filters, await allowedClientIds(gate.user));
    rows = (await gatherExportRows({ mode, source, filters: effFilters, selectedIds: effSelected, rangeFrom, rangeTo: effTo, userId: gate.user.id ?? null })) as Row[];
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to gather agents" }, { status: 500 });
  }
  if (cap && rows.length > cap) rows = rows.slice(0, cap); // belt and braces

  if (rows.length === 0) return NextResponse.json({ error: "No agents match — nothing to export." }, { status: 400 });

  const header = keys.map((k) => esc(labelByKey[k])).join(",");
  const lines = rows.map((r) => keys.map((k) => esc(EXPORT_VALUE[k]?.(r))).join(","));
  const csv = [header, ...lines].join("\r\n");

  await logAudit({
    action: "csv_export",
    performedBy: gate.user.email ?? null,
    details: `Exported ${rows.length} agents to CSV (${keys.length} cols)${cap && capped ? ` — clamped to the ${cap}-row cap` : ""}`,
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="brokerstaffer-agents.csv"`,
    },
  });
}
