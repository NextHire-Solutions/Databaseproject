/*
 * Persist the campaign -> client match as an ID, instead of recomputing it
 * from a name on every run and throwing the answer away.
 *
 * ---------------------------------------------------------------------------
 * WHY
 *
 * `runLeadSync` already resolves every campaign to a client — that is how leads
 * get attached. It then discards the result. the link has nowhere
 * to go. `bison_campaigns.client_id` is a foreign key to `clients`, a two-row
 * table holding the EmailBison workspace key — not to the orchestrator's 43
 * real clients. Migration 0122 adds `orch_client_id`, which points at the right
 * table; this fills it.
 *
 * The architecture spec calls this out twice — §19's Campaigns band ("resolve,
 * but by name more than by ID") and §14 item 12. Stamping the id closes the gap
 * without changing how the match is DECIDED: same matcher, same rules, the
 * answer is just kept.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS BUYS, BEYOND TIDINESS
 *
 *   * Anything downstream can join on an id rather than re-deriving a name.
 *   * `client_id IS NULL` becomes a real question you can ask: "which campaigns
 *     does the matcher fail on?" — today that is only visible in a log line.
 *   * A campaign renamed away from its client keeps its link until the matcher
 *     genuinely reassigns it, rather than silently detaching mid-run.
 *
 * ---------------------------------------------------------------------------
 * CLEARING IS AS IMPORTANT AS SETTING
 *
 * If a campaign was stamped and no longer matches — renamed, or its client
 * churned and was removed — the stale id must be cleared, or a join by id
 * quietly reports a client that the name no longer supports. `toClear` carries
 * those, and applying a plan writes both halves.
 */

export interface CampaignRow {
  /** EmailBison's id for the campaign — `raw->>'id'` falling back to the column. */
  bisonId: string;
  name: string | null;
  /** What is stamped today, or null. */
  clientId: string | null;
}

export interface StampPlan {
  /** Campaigns to stamp, or re-stamp with a different client. */
  toSet: { bisonId: string; clientId: string }[];
  /** Campaigns whose stored client no longer matches, to be blanked. */
  toClear: string[];
  /** Already correct — the steady state, and what most runs should be. */
  unchanged: number;
  /** Resolved to no client and were already blank. Not a change, but worth counting. */
  stillUnmatched: number;
}

/**
 * Work out what would change. Pure, so it can be dry-run against production
 * and read before anything is written — which is how this was first verified.
 */
export function planStamps(
  rows: CampaignRow[],
  match: (name: string | null, bisonId: string) => { id: string } | null,
): StampPlan {
  const plan: StampPlan = { toSet: [], toClear: [], unchanged: 0, stillUnmatched: 0 };

  for (const row of rows) {
    const client = match(row.name, row.bisonId);
    const want = client?.id ?? null;

    if (want === row.clientId) {
      if (want === null) plan.stillUnmatched += 1;
      else plan.unchanged += 1;
      continue;
    }
    if (want === null) plan.toClear.push(row.bisonId);
    else plan.toSet.push({ bisonId: row.bisonId, clientId: want });
  }

  return plan;
}

/** True when applying this plan would write nothing. */
export function isNoop(plan: StampPlan): boolean {
  return plan.toSet.length === 0 && plan.toClear.length === 0;
}

/** One line for the sync's response and the audit log. */
export function describePlan(plan: StampPlan): string {
  return (
    `${plan.toSet.length} stamped, ${plan.toClear.length} cleared, ` +
    `${plan.unchanged} already correct, ${plan.stillUnmatched} still unmatched`
  );
}

interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
}

/**
 * Write the plan. Two statements rather than one per campaign: 256 round trips
 * inside a sync that already takes ten minutes is a cost with no upside.
 *
 * Matched on `coalesce(raw->>'id', bison_campaign_id)` because that is the
 * expression the sync itself uses to identify a campaign — the two must agree
 * or a stamp lands on the wrong row.
 */
export async function applyStamps(db: Queryable, plan: StampPlan): Promise<void> {
  if (plan.toSet.length) {
    await db.query(
      `update bison_campaigns bc
          set orch_client_id = v.client_id::uuid
         from (select unnest($1::text[]) as bison_id, unnest($2::text[]) as client_id) v
        where coalesce(bc.raw->>'id', bc.bison_campaign_id) = v.bison_id
          and bc.orch_client_id is distinct from v.client_id::uuid`,
      [plan.toSet.map((s) => s.bisonId), plan.toSet.map((s) => s.clientId)],
    );
  }
  if (plan.toClear.length) {
    await db.query(
      `update bison_campaigns bc
          set orch_client_id = null
        where coalesce(bc.raw->>'id', bc.bison_campaign_id) = any($1::text[])
          and bc.orch_client_id is not null`,
      [plan.toClear],
    );
  }
}
