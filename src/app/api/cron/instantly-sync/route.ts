import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getPool } from "@/lib/db/pool";
import { fetchCampaigns, fetchRepliedLeads, fetchBouncedLeads, fetchAllLeads } from "@/lib/integrations/instantly";
import { makeCampaignMatcher, instantlyPrefix } from "@/lib/bison/match-campaign";
import { logAudit } from "@/lib/api/log-audit";
import { getCaller, callerCan } from "@/lib/auth/caller";

export const maxDuration = 300;

// Mirrors Instantly into instantly_client_leads: campaign MEMBERSHIP plus replied and bounced
// flags, the same shape bison_client_leads has. 0108 renamed the table and added the flags; the
// SQL functions read it through v_replied_agents / v_bounced_agents / v_agent_campaigns.
//
// This used to be replies-only. Membership was added because 58,240 agents sat in an Instantly
// campaign and no Bison campaign, so they read as "not in campaign" while being actively emailed —
// the same blind spot replies had before 0106.
//
// TWO THINGS IT DOES DELIBERATELY DIFFERENTLY FROM bison-sync:
//
// 1. ONE TRANSACTION, FLAGS ALREADY RESOLVED. Bison replaces campaign by campaign and re-inserts
//    rows with replied/bounced at their default false, then reconciles them after the whole loop —
//    which left a 10-15 minute window where the Replied filter under-reported, measured draining
//    from 2,731 rows to 153 mid-sync. Here all three sweeps finish first, every row is built with
//    its flags already set, and the delete+insert is one transaction. There is no intermediate
//    state to observe at all.
//
// 2. NO REAPER. Bison deletes rows for campaigns that vanished; replacing the whole table in one
//    statement makes that unnecessary — anything absent from the new membership sweep is simply
//    not re-inserted.
//
// Runs in the BACKGROUND like bison-sync: membership alone is ~14 minutes, far past maxDuration.
// The route returns 202 and the real numbers land in audit_logs (action='instantly_reply_sync').
function authorized(req: NextRequest): boolean {
  const token =
    req.headers.get("x-cron-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expect = process.env.CRON_TOKEN ?? "";
  // length is checked first because timingSafeEqual THROWS on unequal buffer lengths
  if (expect && token.length === expect.length && timingSafeEqual(Buffer.from(token), Buffer.from(expect))) {
    return true;
  }
  return false;
}

interface Row {
  campaign_id: string;
  campaign_name: string | null;
  client_id: string | null;
  email: string;
  agent_id: string | null;
  reply_count: number | null;
  last_reply_at: string | null;
  replied: boolean;
  bounced: boolean;
}

async function runSync(key: string): Promise<void> {
  const pool = getPool();
  const warnings: string[] = [];

  // Session-scoped advisory lock on ONE dedicated connection held for the whole run. pool.query
  // would take the lock on one connection and "unlock" on another, which silently does nothing.
  const lockConn = await pool.connect();
  const lock = await lockConn.query("select pg_try_advisory_lock(hashtext('instantly-reply-sync')) as ok");
  if (!lock.rows[0].ok) {
    lockConn.release();
    // This path used to return 200 and write NOTHING, so a lock stuck by a killed run looked
    // exactly like a healthy sync — the mirror would quietly stop updating with no trace anywhere.
    await logAudit({
      action: "instantly_reply_sync",
      performedBy: "cron",
      details: "SKIPPED: another Instantly sync holds the lock",
    }).catch(() => {});
    return;
  }

  try {
    // 1. the three sweeps. Each fails loud on truncation, so a partial read never reaches the
    //    replace below — absence in the membership list means "no longer in a campaign".
    const members = await fetchAllLeads(key);
    const replied = await fetchRepliedLeads(key);
    const bounced = await fetchBouncedLeads(key);
    const campaigns = await fetchCampaigns(key);
    const campaignName = new Map(campaigns.map((c) => [c.campaign_id, c.name]));

    const repliedSet = new Set(replied.map((r) => r.email));
    const bouncedSet = new Set(bounced.map((r) => r.email));
    // reply metadata is keyed by email: the membership row is what gets stored, and the reply
    // sweep is where reply_count / last_reply_at come from
    const replyMeta = new Map(replied.map((r) => [r.email, r]));

    // 2. best-effort campaign -> client. Instantly names its campaigns
    // "Client Name (N) - Market - Market", not Bison's "Client + Sender + Market", so it needs its
    // own prefix rule; the scoring and the refusal to guess on a tie are shared.
    //
    // Most campaigns will NOT map, and that is expected rather than a failure: Instantly serves 87
    // distinct client prefixes across 313 campaigns while orch_clients holds 30. An unmapped
    // campaign still flags its agents — only client_id is left null, which is why the column is
    // nullable here and NOT NULL on bison_client_leads.
    const clients = (
      await pool.query("select id, client_name, bison_campaign_id from orch_clients where client_name is not null")
    ).rows as { id: string; client_name: string | null; bison_campaign_id: string | null }[];
    const matchCampaign = makeCampaignMatcher(clients, instantlyPrefix);

    // 3. resolve agents by email, same three tiers and the same precedence as bison-sync —
    // preferred outranks enriched outranks agent-provided, each tier only filling what the
    // previous missed, `order by id` so an ambiguous address resolves deterministically.
    //
    // Done in chunks: this is now ~149k distinct emails rather than ~7k, and one array parameter
    // that size is a query the planner handles badly.
    const emails = [...new Set(members.map((r) => r.email))];
    const matched = new Map<string, string>();
    const CHUNK = 10000;
    const tier = async (sql: string, list: string[]) => {
      for (let i = 0; i < list.length; i += CHUNK) {
        const slice = list.slice(i, i + CHUNK);
        if (!slice.length) continue;
        const { rows } = await pool.query(sql, [slice]);
        for (const r of rows) if (r.e && !matched.has(r.e)) matched.set(r.e, r.id);
      }
    };
    await tier("select id, lower(preferred_email) e from agents where lower(preferred_email) = any($1) order by id", emails);
    await tier(
      "select id, lower(enriched_email) e from agents where lower(enriched_email) = any($1) order by id",
      emails.filter((e) => !matched.has(e))
    );
    await tier(
      "select id, lower(source_ids->'agent_provided'->>'email') e from agents where lower(source_ids->'agent_provided'->>'email') = any($1) order by id",
      emails.filter((e) => !matched.has(e))
    );

    // 4. empty-response guard — an API blip must never empty the mirror
    const existing = (await pool.query("select count(*)::int n from instantly_client_leads")).rows[0].n as number;
    if (members.length === 0 && existing > 0) {
      warnings.push(`empty membership sweep, kept ${existing} existing rows`);
      await logAudit({
        action: "instantly_reply_sync",
        performedBy: "cron",
        details: `SKIPPED: empty response, kept ${existing} rows — ${warnings.join("; ")}`,
      });
      return;
    }

    // 5. build every row with its flags ALREADY set, then replace the table in one transaction.
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const m of members) {
      const cid = m.campaign_id ?? "";
      const k = `${cid}|${m.email}`;
      if (seen.has(k)) continue; // the table is unique on (campaign_id, email)
      seen.add(k);
      const meta = replyMeta.get(m.email);
      rows.push({
        campaign_id: cid,
        campaign_name: cid ? campaignName.get(cid) ?? null : null,
        client_id: cid ? matchCampaign(campaignName.get(cid) ?? null, cid)?.id ?? null : null,
        email: m.email,
        agent_id: matched.get(m.email) ?? null,
        reply_count: meta?.reply_count ?? null,
        last_reply_at: meta?.last_reply_at ?? null,
        replied: repliedSet.has(m.email),
        bounced: bouncedSet.has(m.email),
      });
    }

    // A replier or bouncer whose campaign no longer lists them still belongs in the mirror —
    // dropping them would silently un-reply an agent who really did reply. Carry them as their own
    // row so v_replied_agents keeps them.
    for (const [set, isReplied] of [[replied, true], [bounced, false]] as const) {
      for (const r of set) {
        const cid = r.campaign_id ?? "";
        const k = `${cid}|${r.email}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({
          campaign_id: cid,
          campaign_name: cid ? campaignName.get(cid) ?? null : null,
          client_id: cid ? matchCampaign(campaignName.get(cid) ?? null, cid)?.id ?? null : null,
          email: r.email,
          agent_id: matched.get(r.email) ?? null,
          reply_count: isReplied ? r.reply_count : null,
          last_reply_at: isReplied ? r.last_reply_at : null,
          replied: repliedSet.has(r.email),
          bounced: bouncedSet.has(r.email),
        });
      }
    }

    const dbc = await pool.connect();
    try {
      await dbc.query("begin");
      await dbc.query("delete from instantly_client_leads");
      // inserted in batches: one jsonb parameter holding 150k rows is far past what a single
      // statement should carry, and a failure mid-way still rolls the whole transaction back
      const INS = 5000;
      for (let i = 0; i < rows.length; i += INS) {
        await dbc.query(
          `insert into instantly_client_leads
             (campaign_id, campaign_name, client_id, email, agent_id, reply_count, last_reply_at, replied, bounced)
           select x.campaign_id, x.campaign_name, x.client_id, x.email, x.agent_id, x.reply_count,
                  x.last_reply_at, x.replied, x.bounced
             from jsonb_to_recordset($1::jsonb) as x(campaign_id text, campaign_name text, client_id uuid,
                                                     email text, agent_id uuid, reply_count int,
                                                     last_reply_at timestamptz, replied boolean, bounced boolean)`,
          [JSON.stringify(rows.slice(i, i + INS))]
        );
      }
      await dbc.query("commit");
    } catch (e) {
      await dbc.query("rollback").catch(() => {});
      throw e;
    } finally {
      dbc.release();
    }

    const linked = rows.filter((r) => r.agent_id).length;
    const repliedRows = rows.filter((r) => r.replied).length;
    const bouncedRows = rows.filter((r) => r.bounced).length;
    const unmapped = new Set(rows.filter((r) => !r.client_id && r.campaign_id).map((r) => r.campaign_name ?? r.campaign_id)).size;
    if (unmapped) warnings.push(`${unmapped} campaign(s) matched no client (flags still applied)`);

    await logAudit({
      action: "instantly_reply_sync",
      performedBy: "cron",
      details:
        `${rows.length} members, ${linked} linked to agents, ${repliedRows} replied, ${bouncedRows} bounced` +
        (warnings.length ? ` — ${warnings.join("; ")}` : ""),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logAudit({ action: "instantly_reply_sync", performedBy: "cron", details: `FAILED: ${msg}` }).catch(() => {});
  } finally {
    await lockConn.query("select pg_advisory_unlock(hashtext('instantly-reply-sync'))").catch(() => {});
    lockConn.release();
  }
}

async function handle(req: NextRequest) {
  let ok = authorized(req);
  if (!ok) {
    // fallback: the manual "Sync" button on the Clients page — gated by that page's permission
    ok = callerCan(await getCaller(), ["clients"]);
  }
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const key = process.env.INSTANTLY_API_KEY ?? "";
  if (!key) {
    return NextResponse.json(
      { ok: true, replies: 0, error: "No INSTANTLY_API_KEY set on this service." },
      { status: 200 }
    );
  }

  // fire-and-forget, like bison-sync: the sweeps take ~15 minutes, longer than any HTTP client
  // will wait. Errors are caught inside runSync and written to audit_logs.
  void runSync(key);
  return NextResponse.json(
    { ok: true, started: true, note: "runs in background; see audit_logs action=instantly_reply_sync" },
    { status: 202 }
  );
}

export async function POST(req: NextRequest) {
  return handle(req);
}
export async function GET(req: NextRequest) {
  return handle(req);
}
