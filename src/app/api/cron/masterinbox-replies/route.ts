import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";

// Pulls REPLIES from the MasterInbox Supabase into agent_replies.
//
// MasterInbox is used for exactly one question — did this lead reply? Campaign membership,
// campaign names and bounces are NOT read from here; those keep coming from the sequencer
// mirrors (see the bison/instantly sync routes). That separation is deliberate: the sequencer
// mirrors are rebuilt from live campaigns and get pruned when a campaign is deleted, which is
// precisely why replies were moved off them.
//
// A reply in MasterInbox is an INBOUND message; `sender` is the lead's address. Rows are matched
// to agents by email (preferred_email or enriched_email, both lowercased) — the same key the
// sequencer mirrors already use.
//
// One message can match SEVERAL agents: 210 replying addresses belong to more than one agent
// record (usually duplicate agent rows for the same person). Each gets its own row, so none of
// them loses the flag — hence the (source, external_id, agent_id) conflict key rather than
// (source, external_id), which silently kept only the first and cost 224 agents their flag.
//
// Incremental: picks up where it left off using the newest MasterInbox reply already stored,
// minus a re-read window, because `sent_at` is the message time and a message can land in the
// table slightly after the moment it claims. Re-reading is free — inserts are idempotent on
// (source, external_id).
//
// Append-only: this route never deletes from agent_replies.

const OVERLAP_HOURS = 48; // re-read window; cheap insurance against late-arriving rows
const PAGE = 1000;

function authorized(req: NextRequest): boolean {
  const want = process.env.CRON_TOKEN;
  if (!want) return true; // no token configured -> open, same convention as the other cron routes
  const got = req.headers.get("x-cron-token") ?? new URL(req.url).searchParams.get("token");
  return got === want;
}

type Msg = { id: string; sender: string | null; sent_at: string | null; source_provider: string | null };

async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const base = process.env.MASTERINBOX_URL;
  const key = process.env.MASTERINBOX_SERVICE_KEY;
  if (!base || !key) {
    return NextResponse.json(
      { ok: false, error: "MASTERINBOX_URL / MASTERINBOX_SERVICE_KEY not set" },
      { status: 500 }
    );
  }
  const H = { apikey: key, Authorization: `Bearer ${key}` };
  const pool = getPool();

  // Where to resume from. Full backfill on an empty table.
  const { rows: cur } = await pool.query(
    `select max(replied_at) as newest from agent_replies where source = 'masterinbox'`
  );
  const since: string | null = cur[0]?.newest
    ? new Date(new Date(cur[0].newest).getTime() - OVERLAP_HOURS * 3600_000).toISOString()
    : null;

  let scanned = 0;
  let matched = 0;
  let inserted = 0;
  let unmatched = 0;

  try {
    for (let offset = 0; ; offset += PAGE) {
      const filter = since ? `&sent_at=gte.${encodeURIComponent(since)}` : "";
      const url =
        `${base.replace(/\/+$/, "")}/rest/v1/messages` +
        `?select=id,sender,sent_at,source_provider&direction=eq.inbound${filter}` +
        `&order=sent_at.asc&offset=${offset}&limit=${PAGE}`;
      const res = await fetch(url, { headers: H, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`MasterInbox ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const page = (await res.json()) as Msg[];
      if (!Array.isArray(page) || page.length === 0) break;
      scanned += page.length;

      const rows = page
        .filter((m) => (m.sender ?? "").includes("@"))
        .map((m) => ({
          external_id: m.id,
          email: (m.sender ?? "").toLowerCase().trim(),
          replied_at: m.sent_at,
          provider: m.source_provider,
        }));

      if (rows.length) {
        // Match to agents and insert in ONE statement — a reply whose sender matches no agent is
        // simply skipped (not every correspondent is an agent in this database).
        const ins = await pool.query(
          `insert into agent_replies (agent_id, email, replied_at, provider, source, external_id)
           select a.id, x.email, x.replied_at::timestamptz, x.provider, 'masterinbox', x.external_id
             from jsonb_to_recordset($1::jsonb)
                    as x(external_id text, email text, replied_at text, provider text)
             join agents a
               on lower(a.preferred_email) = x.email or lower(a.enriched_email) = x.email
           on conflict (source, external_id, agent_id) where external_id is not null do nothing`,
          [JSON.stringify(rows)]
        );
        inserted += ins.rowCount ?? 0;

        const { rows: m } = await pool.query(
          `select count(*)::int as n from jsonb_to_recordset($1::jsonb) as x(email text)
            where exists (select 1 from agents a
                           where lower(a.preferred_email) = x.email or lower(a.enriched_email) = x.email)`,
          [JSON.stringify(rows.map((r) => ({ email: r.email })))]
        );
        matched += m[0]?.n ?? 0;
        unmatched += rows.length - (m[0]?.n ?? 0);
      }

      if (page.length < PAGE) break;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    await pool
      .query(`insert into audit_logs (action, performed_by, details) values ($1,$2,$3)`, [
        "masterinbox_reply_sync",
        "cron",
        `FAILED: ${msg}`,
      ])
      .catch(() => {});
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const { rows: tot } = await pool.query(`select count(*)::int as n from v_replied_agents`);
  const detail = `scanned ${scanned} inbound, matched ${matched}, inserted ${inserted}, unmatched ${unmatched}; agents flagged replied: ${tot[0]?.n}`;
  await pool
    .query(`insert into audit_logs (action, performed_by, details) values ($1,$2,$3)`, [
      "masterinbox_reply_sync",
      "cron",
      detail,
    ])
    .catch(() => {});

  return NextResponse.json({
    ok: true,
    since,
    scanned,
    matched,
    inserted,
    unmatched,
    repliedAgents: tot[0]?.n ?? null,
  });
}

export const GET = handle;
export const POST = handle;
export const maxDuration = 300;
