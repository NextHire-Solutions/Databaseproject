import { getPool } from "@/lib/db/pool";
import { sanitizeSavedViews } from "@/lib/filters/sanitize-saved-views";
import { EXPORT_MAX_ROWS } from "@/lib/export/limits";

// Shared row-gathering for both export paths (CSV + campaign send) so they can't drift.
// The export always produces AGENT rows. In Office mode it expands the chosen offices into
// every agent that belongs to them (agents.office_id), so you can target whole brokerages.
//
// Large exports (10k+) used to time out because the old path built a giant JSON through the
// API layer. Now we get just the matching ids fast (fn_filter_ids), then fetch full rows in
// chunks through the direct pool (2-min timeout) — any size works.

type GatherArgs = {
  mode?: string;
  source?: string;
  filters?: Record<string, unknown>;
  userId?: string | null; // gates saved-view include/exclude references (A12)
  selectedIds?: unknown;
  rangeFrom?: unknown;
  rangeTo?: unknown;
  // A22 fix: campaign sends take a spread SAMPLE of the filtered set instead of its
  // highest-volume head. Exports keep sales_volume desc — a CSV is read top-down and is
  // expected to lead with the biggest producers. Ignored when specific agents were
  // hand-picked: an explicit selection already decided who goes.
  randomize?: boolean;
};

// agent.* + its MLS affiliations (same shape the export columns expect). Ordered by the id
// list's position so the export keeps the search's sort order.
const AGENT_SELECT = `
  select a.*,
    (select jsonb_agg(jsonb_build_object('code', m.code, 'member_id', am.mls_member_id))
       from agent_mls am join mls m on m.id = am.mls_id where am.agent_id = a.id) as mls
  from agents a`;

const CHUNK = 5000;

// Fetch full agent rows for a list of ids, in chunks, preserving the id-list order.
// Ids are deduped first — a repeated id in selectedIds must not emit the agent twice.
async function fetchAgentRowsByIds(rawIds: string[]): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(rawIds)];
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { rows } = await getPool().query(
      `${AGENT_SELECT}
         join unnest($1::uuid[]) with ordinality as u(id, ord) on u.id = a.id
        order by u.ord`,
      [chunk]
    );
    out.push(...(rows as Record<string, unknown>[]));
  }
  return out;
}

export async function gatherExportRows(args: GatherArgs): Promise<Record<string, unknown>[]> {
  const { mode = "agent", source = "courted", selectedIds, rangeFrom, rangeTo, userId = null, randomize = false } = args;
  const sortBy = randomize ? "random" : "sales_volume";
  const filters = await sanitizeSavedViews(args.filters ?? {}, userId);
  const from = Number(rangeFrom) > 0 ? Number(rangeFrom) : 1;
  const to = Number(rangeTo) > 0 ? Number(rangeTo) : null;
  if (to && to < from) return []; // inverted range -> empty, not a negative LIMIT error
  const limit = to ? to - from + 1 : EXPORT_MAX_ROWS;
  const offset = Math.max(from - 1, 0);
  const hasSelection = Array.isArray(selectedIds) && selectedIds.length > 0;
  const pool = getPool();

  // ---------- OFFICE MODE: chosen offices -> all of their agents ----------
  if (mode === "office") {
    let officeIds: string[];
    if (hasSelection) {
      officeIds = selectedIds as string[];
    } else {
      const { rows } = await pool.query(
        `select fn_filter_ids('office', $1, $2::jsonb, $5, 'desc', $3, $4) as ids`,
        [source, JSON.stringify(filters), Math.min(limit, EXPORT_MAX_ROWS), offset, sortBy]
      );
      officeIds = (rows[0]?.ids ?? []) as string[];
    }
    if (officeIds.length === 0) return [];
    // Cap total exported agents at EXPORT_MAX_ROWS (an office can hold many agents). The cap
    // itself is volume-ordered for exports; for a send it must be sampled too, or the cap
    // re-introduces exactly the top-producer bias we just removed from the office pick.
    const { rows } = await pool.query(
      `${AGENT_SELECT} where a.office_id = any($1::uuid[])
        order by ${randomize ? "md5(a.id::text)" : "a.sales_volume desc nulls last"} limit ${EXPORT_MAX_ROWS}`,
      [officeIds]
    );
    return rows as Record<string, unknown>[];
  }

  // ---------- AGENT MODE ----------
  if (hasSelection) {
    return fetchAgentRowsByIds(selectedIds as string[]);
  }
  const { rows } = await pool.query(
    `select fn_filter_ids('agent', $1, $2::jsonb, $5, 'desc', $3, $4) as ids`,
    [source, JSON.stringify(filters), Math.min(limit, EXPORT_MAX_ROWS), offset, sortBy]
  );
  const ids = (rows[0]?.ids ?? []) as string[];
  if (ids.length === 0) return [];
  return fetchAgentRowsByIds(ids);
}
