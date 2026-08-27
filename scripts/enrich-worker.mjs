// Enrichment worker — runs as its own Railway service (long-running, NOT a cron).
// Replaces the Clay table: claims queued enrichment_items, finds/verifies an email for each
// agent (steps replicated from the client's Clay table), caches the result on agents, then
// pushes finished leads into the chosen EmailBison campaign exactly the way Clay did
// (POST /api/leads with the workspace's custom variables, then attach-leads to the campaign).
//
// Concurrency/crash model (hardened after adversarial review):
//   * Every claim stamps a fresh claim_token; every write is fenced on that token, so an
//     overlapping worker (normal during Railway deploys) can reclaim stale items without the
//     old worker clobbering its state.
//   * bison_lead_id is persisted BEFORE attach so crash recovery never re-creates the lead.
//   * Graceful shutdown releases claimed-but-unprocessed items immediately.
//   * The enrichment cache on agents is only written by REAL enrichment steps — the testing
//     fallback never poisons it. not_found is only cached when every step ran cleanly.
//   * With no steps configured (and no fallback), the enrich stage doesn't claim at all —
//     items wait as 'pending' until the Clay steps land.
//
// Env:
//   DATABASE_URL                 required
//   BISON_API_KEY                workspace key (falls back to any clients.bison_api_key)
//   BISON_API_BASE               default https://send.brokerstaffer.com/api
//   BISON_RATE_PER_SEC           default 5
//   POLL_MS                      idle sleep between cycles, default 5000
//   CLAIM_BATCH                  items claimed per cycle, default 25
//   STALE_MIN                    reclaim items stuck in a transient status, default 60
//   BETTERENRICH_API_KEY         BetterEnrich (personal/work email finders)
//   INSTANTLY_API_KEY            Instantly (email verification)
//   OPENAI_API_KEY               "Claygent" web-research steps (LinkedIn + office domain)
//   USE_PREFERRED_EMAIL_FALLBACK "1" = use agents.preferred_email when provider keys are not
//                                set (testing only — result is NOT cached on agents)

import pg from "pg";
import { randomUUID } from "node:crypto";

const env = process.env;
const BASE = (env.BISON_API_BASE || "https://send.brokerstaffer.com/api").replace(/\/+$/, "");
const RATE = Math.max(1, Number(env.BISON_RATE_PER_SEC) || 5);
const POLL_MS = Number(env.POLL_MS) || 5000;
const CLAIM_BATCH = Math.min(100, Number(env.CLAIM_BATCH) || 25); // <=100 keeps one attach chunk per claim
const STALE_MIN = Number(env.STALE_MIN) || 60;
const MAX_ATTEMPTS = 3;
const FALLBACK = env.USE_PREFERRED_EMAIL_FALLBACK === "1";
// Items enrich concurrently — an item is ~15s of SERIAL external API waits, so sequential
// processing capped the pipeline at ~3 items/min. 429s are already retried with backoff
// per call (jsonFetch); dial down via env if a provider starts erroring under load.
const ENRICH_CONCURRENCY = Math.max(1, Math.min(25, Number(env.ENRICH_CONCURRENCY) || 8));

if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Math.max(10, ENRICH_CONCURRENCY + 4) });
pool.on("error", (e) => console.error("pg pool idle-client error:", e.message)); // never crash the loop

let shuttingDown = false;
process.on("SIGTERM", () => { shuttingDown = true; console.log("SIGTERM — releasing unprocessed items, then exiting"); });
process.on("SIGINT", () => { shuttingDown = true; });

// ---------------------------------------------------------------------------
// EmailBison client (same workspace/key the campaign sync uses)
// ---------------------------------------------------------------------------
let bisonKey = env.BISON_API_KEY || null;
async function getBisonKey() {
  if (bisonKey) return bisonKey;
  const { rows } = await pool.query(
    "select bison_api_key from clients where bison_api_key is not null order by created_at limit 1"
  );
  bisonKey = rows[0]?.bison_api_key ?? null;
  if (!bisonKey) throw new Error("No EmailBison API key (set BISON_API_KEY or store one on a client)");
  return bisonKey;
}

// Global rate gate: starts are spaced >= 1/RATE sec apart, shared by every Bison call.
let nextStart = 0;
async function rateGate() {
  const now = Date.now();
  const at = Math.max(now, nextStart);
  nextStart = at + Math.ceil(1000 / RATE) + 15;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function bison(method, path, body, attempt = 1) {
  await rateGate();
  const key = await getBisonKey();
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return bison(method, path, body, attempt + 1);
    }
    throw new Error(`Bison ${method} ${path}: ${e instanceof Error ? e.message : "network error"}`);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      return bison(method, path, body, attempt + 1);
    }
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = json?.data?.message || json?.message || text.slice(0, 200);
    const err = new Error(`Bison ${method} ${path} -> ${res.status}: ${msg}`);
    err.status = res.status;
    err.bisonMessage = msg;
    throw err;
  }
  return json;
}

// Find an existing lead by email (search matches full email; exact-match the result).
async function findBisonLeadByEmail(email, tries = 1) {
  for (let t = 0; t < tries; t++) {
    if (t > 0) await new Promise((r) => setTimeout(r, 2000)); // search indexing delay
    const found = await bison("GET", `/leads?search=${encodeURIComponent(email)}`);
    const hit = (found?.data ?? []).find((l) => (l.email || "").toLowerCase() === email.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// Create-or-update by email (mirrors Clay's "Create or Update Lead" enrichment).
async function upsertBisonLead(payload) {
  try {
    const j = await bison("POST", "/leads", payload);
    const id = j?.data?.id ?? j?.id;
    if (id != null) return String(id);
    throw new Error("Bison POST /leads returned no lead id");
  } catch (e) {
    // Only a duplicate email means "find and update"; other 4xx are real validation errors.
    if (!/taken|already exists|duplicate/i.test(e.bisonMessage ?? e.message)) throw e;
  }
  const hit = await findBisonLeadByEmail(payload.email, 3);
  if (!hit) throw new Error(`Lead exists but could not be found by search: ${payload.email}`);
  await bison("PUT", `/leads/${hit.id}`, payload); // Clay's "PUT: replace all fields" behavior
  return String(hit.id);
}

// ---------------------------------------------------------------------------
// Client-scope dedup. Campaign naming convention: "Client Name + Sender + Market" —
// the prefix before the first " + " is the client. A lead already sitting in ANY of the
// same client's campaigns is skipped, not re-uploaded.
// ---------------------------------------------------------------------------
const clientPrefix = (name) => (name ?? "").split(" + ")[0].trim().toLowerCase();
const campaignNameCache = new Map(); // bison campaign id -> name

async function campaignNameById(id) {
  const key = String(id);
  if (campaignNameCache.has(key)) return campaignNameCache.get(key);
  // synced table first, Bison API for campaigns created since the last sync
  const { rows } = await pool.query(
    `select name from bison_campaigns where coalesce(raw->>'id', bison_campaign_id) = $1 limit 1`,
    [key]
  );
  let name = rows[0]?.name ?? null;
  if (!name) {
    try {
      const j = await bison("GET", `/campaigns/${key}`);
      name = j?.data?.name ?? null;
    } catch { /* unknown campaign: treat as no match */ }
  }
  campaignNameCache.set(key, name);
  return name;
}

// Per-campaign, per-client dedup. For a target campaign, return the name of ANY campaign of
// that SAME campaign's client the lead is already in (including the target itself) — meaning
// skip the target: the client has already contacted (or is contacting) this lead, and
// attaching again risks double-contact or restarting a finished sequence. Pre-existing
// membership blocks even when the existing campaign is also targeted by this batch — the
// dedup decision is made ONCE against pre-batch state and persisted (target_campaign_ids),
// so a retry never mistakes this batch's own attaches for prior membership.
// Returns null = ok to attach.
async function leadBlockedForCampaign(lead, targetCampaignId) {
  const targetClient = clientPrefix(await campaignNameById(targetCampaignId));
  if (!targetClient) return null;
  for (const c of lead?.lead_campaign_data ?? []) {
    const name = await campaignNameById(c.campaign_id);
    if (name && clientPrefix(name) === targetClient) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source priority — which source's values win for the merged lead fields; blanks fall
// back down the order. Per-source values live in agents.source_ids (email/phone/city/
// office_name/profile_url) and agent_source_stats; older courted rows predate the stash,
// so 'courted' falls back to the canonical columns (which are courted-authoritative).
// ---------------------------------------------------------------------------
// agent_provided = contact info the agent gave us directly (C3) — always wins.
const PRIORITY_ORDERS = {
  courted: ["agent_provided", "courted", "zillow", "realtor"],
  zillow: ["agent_provided", "zillow", "courted", "realtor"],
  realtor: ["agent_provided", "realtor", "courted", "zillow"],
};
const orderFor = (priority) => PRIORITY_ORDERS[priority] ?? PRIORITY_ORDERS.courted;

function srcVal(agent, src, key, canonicalKey) {
  const v = agent.source_ids?.[src]?.[key];
  if (v != null && v !== "") return v;
  if (src === "courted" && (agent.sources ?? []).includes("courted")) return agent[canonicalKey] ?? null;
  return null;
}
function byPriority(agent, order, key, canonicalKey) {
  for (const src of order) {
    const v = srcVal(agent, src, key, canonicalKey);
    if (v != null && v !== "") return v;
  }
  return agent[canonicalKey] ?? null; // merged column as the last resort
}
function statByPriority(agent, order, key, canonicalKey) {
  for (const src of order) {
    const v = agent.stats_by_source?.[src]?.[key];
    if (v != null) return v;
  }
  return agent[canonicalKey] ?? null;
}

// ---------------------------------------------------------------------------
// Lead mapper — matches the Clay "Create or update lead" columns (July 2026 screenshots):
// 12 custom variables, sent on EVERY lead (empty string when unknown, so the variable always
// exists on the lead — Clay uses "PUT: replace all fields").
//
// A3 (client request, Aug 2026): the Courted profile link must NOT reach campaigns. The
// variable is still SENT but always empty, deliberately — sending it blank overwrites the link
// on the ~30k leads already in Bison as the worker touches them again, which dropping the key
// entirely would not reliably do. No email copy referenced it (checked across 139 live
// campaigns: only {FIRST_NAME}, {firstName}, {PHONE NUMBER} and {TOP PRODUCING CITY} appear),
// so nothing renders differently. Do not "restore Clay parity" by repopulating it.
// ---------------------------------------------------------------------------
const money = (v) => (v == null || v === "" ? "" : `$${Math.round(Number(v)).toLocaleString("en-US")}`);
const num = (v) => (v == null ? "0" : String(v));
const cityState = (city, st) => (city ? (st ? `${city}, ${st}` : city) : "");
function splitName(full) {
  const parts = (full ?? "").trim().split(/\s+/);
  return { first: parts[0] || "Unknown", last: parts.slice(1).join(" ") || "-" };
}

export function mapAgentToBisonLead(agent, email, mlsCode, order = PRIORITY_ORDERS.courted) {
  const first = agent.first_name || splitName(agent.full_name).first;
  const last = agent.last_name || splitName(agent.full_name).last;
  const vars = [
    ["buy-side", money(agent.buy_side_dollar)],
    ["list-side", money(agent.list_side_dollar)],
    ["office city", cityState(agent.office_city, agent.office_state)],
    ["phone number", byPriority(agent, order, "phone", "preferred_phone") ?? ""],
    ["sales volume", money(agent.sales_volume)],
    ["estimated gci", money(agent.approx_gci)],
    ["closed rentals", num(agent.closed_rentals)],
    ["courted profile", ""], // A3: never send the Courted link; blank overwrites existing leads
    ["mls affiliation", mlsCode ?? ""],
    ["top producing city", cityState(byPriority(agent, order, "city", "most_transacted_city"), agent.transacted_state)],
    ["average sales price", money(agent.avg_sale_price)],
    ["closed transactions", num(statByPriority(agent, order, "closed_transactions", "closed_transactions"))],
  ];
  return {
    first_name: first,
    last_name: last,
    email,
    company: byPriority(agent, order, "office_name", "office_name") || agent.brand || undefined,
    custom_variables: vars.map(([name, value]) => ({ name, value })),
  };
}

// ---------------------------------------------------------------------------
// Enrichment — the Clay-table replica lives in enrich-flow.mjs (both branches:
// "No Emails -> Enrich Both" and "FLOW: Both Emails -> Priority Pro -> Enrich Both").
// It runs when BETTERENRICH_API_KEY + INSTANTLY_API_KEY + OPENAI_API_KEY are set.
// ---------------------------------------------------------------------------
import { enrichAgent, providersConfigured } from "./enrich-flow.mjs";

// Returns { hit, cleanRun }. cleanRun = no step errored, so a null result is a trustworthy
// "no email exists" (cacheable) rather than a provider outage.
async function runEnrichment(agent, log) {
  if (providersConfigured()) {
    return enrichAgent(agent, log);
  }
  if (FALLBACK && agent.preferred_email) {
    log.push({ step: "preferred_email_fallback", ok: true, ms: 0, note: "testing fallback (not cached)" });
    return { hit: { email: agent.preferred_email, status: "unknown", provider: "preferred_email" }, cleanRun: true };
  }
  return { hit: null, cleanRun: false };
}

// ---------------------------------------------------------------------------
// Queue plumbing — every write is fenced on the claim_token taken at claim time.
// ---------------------------------------------------------------------------
async function reclaimStale() {
  await pool.query(
    `update enrichment_items set status = 'pending', claimed_at = null, claim_token = null, updated_at = now()
      where status = 'enriching' and claimed_at < now() - ($1 || ' minutes')::interval`,
    [STALE_MIN]
  );
  await pool.query(
    `update enrichment_items set status = 'enriched', claimed_at = null, claim_token = null, updated_at = now()
      where status = 'pushing' and claimed_at < now() - ($1 || ' minutes')::interval`,
    [STALE_MIN]
  );
}

async function claim(fromStatus, toStatus, extraWhere = "") {
  const token = randomUUID();
  const { rows } = await pool.query(
    `update enrichment_items i
        set status = $2, claimed_at = now(), claim_token = $4, updated_at = now()
      where i.id in (
        select e.id from enrichment_items e
          join enrichment_batches b on b.id = e.batch_id
         where e.status = $1 and b.status <> 'cancelled' ${extraWhere}
         order by e.created_at
         limit $3
         for update of e skip locked
      )
      returning i.*`,
    [fromStatus, toStatus, CLAIM_BATCH, token]
  );
  if (rows.length) {
    await pool.query(
      `update enrichment_batches set status = 'running' where status = 'queued' and id = any($1::uuid[])`,
      [[...new Set(rows.map((r) => r.batch_id))]]
    );
  }
  return { token, items: rows };
}

async function loadAgents(agentIds) {
  // source_ids stores per-source values RAW; the city entries are normalized here (via the
  // same fn_norm_city the canonical columns use) because the lead mapper's "top producing
  // city" email variable prefers the stash over the normalized most_transacted_city column.
  const { rows } = await pool.query(
    `select a.*, (select m.code from agent_mls am join mls m on m.id = am.mls_id
                   where am.agent_id = a.id limit 1) as mls_code,
            (select jsonb_object_agg(e.k, case when e.v ? 'city'
                      then jsonb_set(e.v, '{city}', coalesce(to_jsonb(fn_norm_city(e.v->>'city')), 'null'::jsonb))
                      else e.v end)
               from jsonb_each(a.source_ids) e(k, v)) as source_ids,
            (select jsonb_object_agg(s.source, to_jsonb(s) - 'agent_id')
               from agent_source_stats s where s.agent_id = a.id) as stats_by_source
       from agents a where a.id = any($1::uuid[])`,
    [agentIds]
  );
  return new Map(rows.map((a) => [a.id, a]));
}

// Fenced write: no-op (returns false) if another worker has reclaimed the item since.
// Any write that releases the item (claimed_at -> null) also drops the fence token.
async function setItem(item, token, fields) {
  const releases = "claimed_at" in fields && fields.claimed_at === null;
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  const { rowCount } = await pool.query(
    `update enrichment_items set ${sets}${releases ? ", claim_token = null" : ""}, updated_at = now()
      where id = $1 and claim_token = $2`,
    [item.id, token, ...keys.map((k) => (k === "step_log" ? JSON.stringify(fields[k]) : fields[k]))]
  );
  if (rowCount === 0) console.warn(`lost claim on item ${item.id} — skipping write`);
  return rowCount > 0;
}

// transient failure -> retry from the given stable status; terminal after MAX_ATTEMPTS
async function failOrRetry(item, token, backTo, err, extraFields = {}) {
  const msg = err instanceof Error ? err.message : String(err);
  const attempts = item.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await setItem(item, token, { ...extraFields, status: "failed", attempts, error: msg, claimed_at: null });
  } else {
    await setItem(item, token, { ...extraFields, status: backTo, attempts, error: msg, claimed_at: null });
  }
}

// Release claimed-but-unprocessed items right away (shutdown / cancelled batch).
async function releaseItems(items, token, backTo) {
  if (items.length === 0) return;
  await pool.query(
    `update enrichment_items set status = $3, claimed_at = null, claim_token = null, updated_at = now()
      where id = any($1::uuid[]) and claim_token = $2`,
    [items.map((i) => i.id), token, backTo]
  );
}

// Refresh counters/finish-state of every active batch (self-heals batches whose final
// refresh was missed by a crash — cheap: the active-batch set is always tiny).
async function refreshActiveBatches() {
  await pool.query(
    `update enrichment_batches b set
        enriched = s.got_email,
        no_email = s.no_email,
        sent     = s.sent,
        failed   = s.failed,
        skipped  = s.skipped,
        status   = case when s.pending_work + (case when b.campaign_id is not null then s.awaiting_push else 0 end) = 0
                        then 'done' else b.status end,
        finished_at = case when s.pending_work + (case when b.campaign_id is not null then s.awaiting_push else 0 end) = 0
                           and b.finished_at is null then now() else b.finished_at end
       from (
         select batch_id,
                count(*) filter (where status in ('enriched','pushing','sent','skipped')) as got_email,
                count(*) filter (where status = 'no_email')                         as no_email,
                count(*) filter (where status = 'sent')                             as sent,
                count(*) filter (where status = 'failed')                           as failed,
                count(*) filter (where status = 'skipped')                          as skipped,
                count(*) filter (where status in ('pending','enriching','pushing')) as pending_work,
                count(*) filter (where status = 'enriched')                         as awaiting_push
           from enrichment_items
          where batch_id in (select id from enrichment_batches where status in ('queued','running'))
          group by batch_id
       ) s
      where b.id = s.batch_id and b.status in ('queued','running')`
  );
  // Orchestrator handshake: once a batch has actually delivered leads into a campaign,
  // flag that campaign as populated (bison_campaigns.leads_imported_campaign). Only campaigns
  // that RECEIVED a sent lead are flagged — a multi-campaign batch where every lead deduped
  // out of one campaign must not mark that campaign populated. Sent items record their real
  // targets in target_campaign_ids (legacy items predate the column: fall back to campaign_id).
  await pool.query(
    `update bison_campaigns bc
        set leads_imported_campaign = true
       from enrichment_batches b
      where b.status = 'done'
        and b.sent > 0
        and b.campaign_id is not null
        and coalesce(bc.raw->>'id', bc.bison_campaign_id) in (
          select unnest(coalesce(i.target_campaign_ids, array[b.campaign_id]))
            from enrichment_items i
           where i.batch_id = b.id and i.status = 'sent')
        and bc.leads_imported_campaign is distinct from true`
  );
}

// ---------------------------------------------------------------------------
// Stage 1 — enrich: fresh cache read wins; otherwise run the step waterfall.
// With no steps configured (and no fallback), don't claim — items wait as 'pending'.
// ---------------------------------------------------------------------------
let warnedNoSteps = false;
async function enrichCycle() {
  if (!providersConfigured() && !FALLBACK) {
    if (!warnedNoSteps) { console.warn("enrichment provider keys not set — enrich stage idle, items stay pending"); warnedNoSteps = true; }
    return false;
  }
  const { token, items } = await claim("pending", "enriching");
  if (items.length === 0) return false;
  const agents = await loadAgents(items.map((i) => i.agent_id));
  // the batch's source priority decides which source's email the enrichment flow verifies first
  const { rows: eBatches } = await pool.query(
    `select id, source_priority from enrichment_batches where id = any($1::uuid[])`,
    [[...new Set(items.map((i) => i.batch_id))]]
  );
  const priorityOf = new Map(eBatches.map((b) => [b.id, b.source_priority]));

  const processOne = async (item) => {
    const agent = agents.get(item.agent_id);
    if (!agent) {
      await setItem(item, token, { status: "failed", error: "agent no longer exists", claimed_at: null });
      return;
    }
    try {
      // Fresh cache read at use time: a sibling batch (or the other worker during a deploy)
      // may have enriched this same agent since our claim — never pay twice.
      // 30-DAY TTL: results older than 30 days re-run the full pipeline (emails go stale,
      // and an old not-found may find one now). Freshness comes from the DB clock — the same
      // clock the cache-write guards use — so the two can never disagree.
      const { rows: [cache] } = await pool.query(
        `select enriched_email, enriched_email_status, enriched_provider, enriched_at,
                (enriched_at is not null and enriched_at >= now() - interval '30 days') as cache_fresh
           from agents where id = $1`,
        [agent.id]
      );
      if (cache?.cache_fresh) {
        if (cache.enriched_email) {
          await setItem(item, token, {
            status: "enriched", attempts: 0, email: cache.enriched_email,
            email_status: cache.enriched_email_status, provider: cache.enriched_provider,
            step_log: [{ step: "cache", ok: true, ms: 0, note: "reused stored enrichment" }],
            error: null, claimed_at: null,
          });
        } else {
          await setItem(item, token, {
            status: "no_email", email_status: "not_found",
            step_log: [{ step: "cache", ok: true, ms: 0, note: "known not-found" }],
            error: null, claimed_at: null,
          });
        }
        return;
      }

      const log = [];
      // priority-resolved email: e.g. zillow priority verifies zillow's email first,
      // falling back to courted's when zillow has none
      const order = orderFor(priorityOf.get(item.batch_id));
      const priorityEmail = byPriority(agent, order, "email", "preferred_email");
      const { hit, cleanRun } = await runEnrichment({ ...agent, preferred_email: priorityEmail }, log);
      if (hit) {
        // The testing fallback must NEVER write the permanent cache — only real steps do.
        if (hit.provider !== "preferred_email") {
          await pool.query(
            `update agents set enriched_email=$1, enriched_email_status=$2, enriched_provider=$3, enriched_at=now()
              where id=$4 and (enriched_at is null or enriched_at < now() - interval '30 days')`,
            [hit.email, hit.status, hit.provider, agent.id]
          );
        }
        await setItem(item, token, {
          status: "enriched", attempts: 0, email: hit.email, email_status: hit.status, provider: hit.provider,
          step_log: log, error: null, claimed_at: null,
        });
      } else if (!hit && cache?.enriched_email && (!providersConfigured() || item.attempts + 1 >= MAX_ATTEMPTS)) {
        // Re-enrichment isn't possible right now (no provider keys / providers erroring on the
        // final attempt) but a stale cached email exists — reuse it rather than losing the lead.
        await setItem(item, token, {
          status: "enriched", attempts: 0, email: cache.enriched_email,
          email_status: cache.enriched_email_status, provider: cache.enriched_provider,
          step_log: log.concat([{ step: "stale_cache", ok: true, ms: 0, note: "re-enrichment unavailable — reused >30d cached email" }]),
          error: null, claimed_at: null,
        });
      } else if (providersConfigured() && cleanRun) {
        // every step ran cleanly and none found an email -> trustworthy not-found, cache it
        await pool.query(
          `update agents set enriched_email=null, enriched_email_status='not_found', enriched_provider=null, enriched_at=now()
            where id=$1 and (enriched_at is null or enriched_at < now() - interval '30 days')`,
          [agent.id]
        );
        await setItem(item, token, { status: "no_email", email_status: "not_found", step_log: log, error: null, claimed_at: null });
      } else if (providersConfigured()) {
        // one or more steps errored -> provider outage, not a real not-found: retry later
        await failOrRetry(item, token, "pending", new Error("enrichment step error (see step_log)"), { step_log: log });
      } else {
        // fallback mode with no preferred_email: terminal for this run, agents cache untouched
        await setItem(item, token, { status: "no_email", email_status: "not_found", step_log: log, error: null, claimed_at: null });
      }
    } catch (e) {
      await failOrRetry(item, token, "pending", e);
    }
  };

  // Concurrent runners pull from a shared cursor; on shutdown, whatever no runner has
  // started goes straight back to pending (started items finish and release themselves).
  let cursor = 0;
  const untaken = new Set(items.map((_, i) => i));
  await Promise.all(
    Array.from({ length: Math.min(ENRICH_CONCURRENCY, items.length) }, async () => {
      for (;;) {
        if (shuttingDown) break;
        const i = cursor++;
        if (i >= items.length) break;
        untaken.delete(i);
        await processOne(items[i]);
      }
    })
  );
  if (shuttingDown && untaken.size) {
    await releaseItems(items.filter((_, i) => untaken.has(i)), token, "pending");
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stage 2 — push: create/update the Bison lead (id persisted BEFORE attach), then attach
// per campaign in chunks, marking each chunk 'sent' as soon as its attach succeeds.
// Only batches WITH a campaign reach this stage.
// ---------------------------------------------------------------------------
async function pushCycle() {
  const { token, items } = await claim("enriched", "pushing", "and b.campaign_id is not null");
  if (items.length === 0) return false;
  const agents = await loadAgents(items.map((i) => i.agent_id));
  const { rows: batches } = await pool.query(
    `select b.id, b.campaign_id, b.campaign_ids, b.status, b.source_priority, b.mls_scope
       from enrichment_batches b where b.id = any($1::uuid[])`,
    [[...new Set(items.map((i) => i.batch_id))]]
  );
  const batchOf = new Map(batches.map((b) => [b.id, b]));

  const toAttach = new Map();      // campaign_id -> [{ item, leadId }]
  const targetsByItem = new Map(); // item.id -> how many campaigns we will attach it to
  const itemById = new Map();      // item.id -> item (for finalize)

  // A5 scoped sends: a batch created from an MLS-scoped search carries mls_scope — its
  // personalization variables must be THAT MLS's numbers, not the all-MLS totals.
  const scopedByBatch = new Map(); // batch_id -> Map(agent_id -> scoped sums + codes)
  for (const b of batches) {
    if (!b.mls_scope?.length) continue;
    const ids = [...new Set(items.filter((i) => i.batch_id === b.id).map((i) => i.agent_id))];
    if (!ids.length) continue;
    const { rows: sc } = await pool.query(
      `select s.agent_id, sum(s.sales_volume) as sales_volume, sum(s.buy_side_dollar) as buy_side_dollar,
              sum(s.list_side_dollar) as list_side_dollar, sum(s.approx_gci) as approx_gci,
              sum(s.closed_transactions) as closed_transactions, sum(s.closed_rentals) as closed_rentals,
              case when sum(s.units) > 0 then sum(coalesce(s.avg_sale_price, 0) * coalesce(s.units, 0)) / sum(s.units) end as avg_sale_price,
              (select string_agg(m2.code, ' | ' order by m2.code) from agent_mls am2 join mls m2 on m2.id = am2.mls_id
                where am2.agent_id = s.agent_id and am2.mls_id = any($2::uuid[])) as mls_codes
         from agent_mls_stats s where s.agent_id = any($1::uuid[]) and s.mls_id = any($2::uuid[]) group by s.agent_id`,
      [ids, b.mls_scope]
    );
    scopedByBatch.set(b.id, new Map(sc.map((r) => [r.agent_id, r])));
  }

  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    if (shuttingDown) {
      await releaseItems(items.slice(n), token, "enriched");
      break;
    }
    const batch = batchOf.get(item.batch_id);
    if (!batch || batch.status === "cancelled") {
      await releaseItems([item], token, "enriched"); // batch cancelled mid-flight: don't push
      continue;
    }
    const agent = agents.get(item.agent_id);
    if (!agent || !item.email) {
      await setItem(item, token, { status: "failed", error: !agent ? "agent no longer exists" : "item has no email", claimed_at: null });
      continue;
    }
    // Every campaign this batch targets (campaign_ids; falls back to the single campaign_id).
    const chosen = (batch.campaign_ids?.length ? batch.campaign_ids : [batch.campaign_id]).filter(Boolean).map(String);
    const chosenSet = new Set(chosen);
    try {
      const sc = scopedByBatch.get(item.batch_id)?.get(item.agent_id);
      const payloadAgent = sc
        ? { ...agent, sales_volume: sc.sales_volume, buy_side_dollar: sc.buy_side_dollar,
            list_side_dollar: sc.list_side_dollar, approx_gci: sc.approx_gci,
            avg_sale_price: sc.avg_sale_price, closed_rentals: sc.closed_rentals,
            closed_transactions: sc.closed_transactions, stats_by_source: null }
        : agent;
      const payload = mapAgentToBisonLead(payloadAgent, item.email, sc ? sc.mls_codes : agent.mls_code, orderFor(batch.source_priority));
      // Does this lead already exist in the workspace? (also our per-client dedup source)
      const existing = await findBisonLeadByEmail(item.email);

      // Per target campaign: attach, unless the lead is already in a campaign of that
      // campaign's own client (per-campaign, per-client dedup). The decision is computed ONCE
      // against pre-batch memberships and persisted in target_campaign_ids — a retry reuses it,
      // so this batch's own partial attaches never block the remaining targets and the
      // client_dedup step notes aren't appended a second time.
      let attachTo;
      const skipNotes = [];
      if (item.target_campaign_ids != null) {
        attachTo = item.target_campaign_ids.map(String).filter((cid) => chosenSet.has(cid));
      } else {
        attachTo = [];
        for (const cid of chosen) {
          const blockedBy = existing ? await leadBlockedForCampaign(existing, cid) : null;
          if (blockedBy) skipNotes.push({ step: "client_dedup", ok: true, ms: 0, note: `skip campaign ${cid}: already in "${blockedBy}"` });
          else attachTo.push(cid);
        }
      }

      if (attachTo.length === 0) {
        // every target campaign deduped -> terminal skip (no lead create/refresh needed)
        await setItem(item, token, {
          status: "skipped", bison_lead_id: existing ? String(existing.id) : (item.bison_lead_id ?? null),
          target_campaign_ids: attachTo,
          error: null, claimed_at: null,
          step_log: (item.step_log ?? []).concat(skipNotes),
        });
        continue;
      }

      // Crash recovery: reuse a previously-created lead id — never duplicate.
      let leadId = item.bison_lead_id ?? (existing ? String(existing.id) : null);
      if (existing) {
        await bison("PUT", `/leads/${existing.id}`, payload); // refresh data, Clay's PUT behavior
      } else if (!leadId) {
        leadId = await upsertBisonLead(payload);
      }
      await setItem(item, token, { bison_lead_id: leadId, target_campaign_ids: attachTo, step_log: (item.step_log ?? []).concat(skipNotes) }); // persist BEFORE attach
      item.bison_lead_id = leadId;
      item.target_campaign_ids = attachTo;
      for (const cid of attachTo) {
        if (!toAttach.has(cid)) toAttach.set(cid, []);
        toAttach.get(cid).push({ item, leadId });
      }
      targetsByItem.set(item.id, attachTo.length);
      itemById.set(item.id, item);
    } catch (e) {
      await failOrRetry(item, token, "enriched", e);
    }
  }

  // Attach per campaign in chunks; tally per-item successes across all its campaigns.
  const okByItem = new Map();  // item.id -> campaigns attached ok
  const errByItem = new Map(); // item.id -> last attach error
  for (const [campaignId, entries] of toAttach) {
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      try {
        await bison("POST", `/campaigns/${campaignId}/leads/attach-leads`, { lead_ids: chunk.map((e) => e.leadId) });
        for (const { item } of chunk) okByItem.set(item.id, (okByItem.get(item.id) ?? 0) + 1);
      } catch (e) {
        for (const { item } of chunk) errByItem.set(item.id, e);
      }
    }
  }

  // Finalize: 'sent' once a lead is attached to ALL its target campaigns; otherwise retry (a
  // retry re-attaches every target — attach-leads is idempotent, so already-attached is fine).
  for (const [id, item] of itemById) {
    const need = targetsByItem.get(id) ?? 0;
    const ok = okByItem.get(id) ?? 0;
    if (need > 0 && ok >= need) {
      try {
        await setItem(item, token, { status: "sent", attempts: 0, bison_lead_id: item.bison_lead_id ?? null, error: null, claimed_at: null });
      } catch (e) {
        console.error(`mark-sent failed for item ${item.id}:`, e instanceof Error ? e.message : e);
      }
    } else {
      await failOrRetry(item, token, "enriched", errByItem.get(id) ?? new Error("attach incomplete"));
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
console.log(`enrich-worker up — rate ${RATE}/s, claim ${CLAIM_BATCH}, poll ${POLL_MS}ms, stale ${STALE_MIN}m, providers: ${providersConfigured()}, fallback: ${FALLBACK}`);
let lastStaleSweep = 0;
while (!shuttingDown) {
  try {
    if (Date.now() - lastStaleSweep > 60_000) {
      await reclaimStale();
      await refreshActiveBatches(); // self-heal batches stranded by a crash
      lastStaleSweep = Date.now();
    }
    const didEnrich = await enrichCycle();
    const didPush = await pushCycle();
    if (didEnrich || didPush) await refreshActiveBatches();
    else await new Promise((r) => setTimeout(r, POLL_MS));
  } catch (e) {
    console.error("cycle error:", e instanceof Error ? e.message : e);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
await pool.end();
console.log("enrich-worker stopped");
