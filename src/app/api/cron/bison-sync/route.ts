import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { makeCampaignMatcher } from "@/lib/bison/match-campaign";
import { createClient } from "@/lib/supabase/server";
import { fetchClientCampaigns, fetchCampaignLeads } from "@/lib/integrations/bison";

export const maxDuration = 300;

async function authorized(req: NextRequest): Promise<boolean> {
  const token = req.headers.get("x-cron-token") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expect = process.env.CRON_TOKEN ?? "";
  if (expect && token.length === expect.length && timingSafeEqual(Buffer.from(token), Buffer.from(expect))) return true;
  // Otherwise allow a logged-in user (the "Sync" button on the Webhooks page).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return !!user;
}

async function handle(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const base = process.env.BISON_API_BASE || "https://send.brokerstaffer.com/api";
  const pool = getPool();

  // All clients share ONE EmailBison workspace, so we pull every campaign once with a single key
  // (env BISON_API_KEY, else any stored client key — they're the same workspace) and associate to
  // clients later by campaign-name prefix ("Client Name + Sender + Market").
  const key =
    process.env.BISON_API_KEY ||
    (await pool.query("select bison_api_key from clients where bison_api_key is not null order by created_at limit 1")).rows[0]?.bison_api_key;
  if (!key) return NextResponse.json({ ok: true, campaigns: 0, error: "No EmailBison workspace key set." });

  try {
    const camps = await fetchClientCampaigns(key, base);
    for (const cm of camps) {
      await pool.query(
        `insert into bison_campaigns (bison_campaign_id, name, status, raw, fetched_at)
         values ($1,$2,$3,$4::jsonb, now())
         on conflict (bison_campaign_id) do update set name=excluded.name, status=excluded.status, raw=excluded.raw, fetched_at=now()`,
        [cm.bison_campaign_id, cm.name, cm.status, JSON.stringify(cm.raw)]
      );
    }
    await pool.query("update clients set bison_synced_at=now()");

    // ---- lead sync (detached): a full mirror takes 10-15 min — far longer than any HTTP
    // client waits. Running it inside the request dies with the connection (verified: two
    // aborted runs), so the handler kicks it off in the background and answers immediately;
    // completion/failure is recorded in audit_logs (action 'bison_lead_sync').
    void runLeadSync(pool, key, base).catch((e) => console.error("lead sync crashed:", e instanceof Error ? e.message : e));
    // B4 safety net: this route already runs every 6h (bison-cron), so piggyback the
    // saved-view recount here — covers direct-SQL data changes no API hook sees
    void pool.query("select fn_refresh_saved_list_counts()").catch(() => {});
    return NextResponse.json({ ok: true, campaigns: camps.length, leadSync: { started: true, note: "runs in background; see audit_logs action=bison_lead_sync" } }, { status: 202 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    return NextResponse.json({ ok: false, campaigns: 0, error: msg }, { status: 500 });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runLeadSync(pool: any, key: string, base: string) {
    // ---- lead sync: mirror campaign membership into bison_client_leads (D1) ----
    // Campaign -> client mapping is FUZZY but ambiguity-safe: names are normalized (lowercase,
    // alphanumerics only, leading "the"/"copy of" dropped, whitespace collapsed) and a campaign
    // prefix maps to a client on exact equality or a >=6-char startsWith either way (numbered
    // variants "Elite Team 2", suffixed "Jeff Cook Real Estate LPT Realty", truncated client
    // names). Multiple candidates -> longest match wins; ties are left unmapped, never guessed.
    // Per campaign the row set is REPLACED atomically; a failed or suspicious fetch leaves the
    // previous rows untouched and is REPORTED (response + audit log).
    // advisory locks are SESSION-scoped: take and release them on one dedicated connection
    // held for the whole run (pool.query would lock on one connection and "unlock" on another)
    const lockConn = await pool.connect();
    const lock = await lockConn.query("select pg_try_advisory_lock(hashtext('bison-lead-sync')) as ok");
    if (!lock.rows[0].ok) {
      lockConn.release();
      console.log("lead sync skipped: another sync is already running");
      return;
    }
    try {
    // norm/mapCampaign now come from @/lib/bison/match-campaign so this and the Export
    // dialog cannot drift apart again — that divergence hid 47 campaigns from 13 clients.
    const clients = (await pool.query(
      "select id, client_name, bison_campaign_id from orch_clients where client_name is not null"
    )).rows as { id: string; client_name: string; bison_campaign_id: string | null }[];
    const matchCampaign = makeCampaignMatcher(clients);

    const mapCampaign = (name: string | null, bisonId: string) => matchCampaign(name, bisonId);

    const campRows = (await pool.query(
      "select coalesce(raw->>'id', bison_campaign_id) as bison_id, name from bison_campaigns"
    )).rows as { bison_id: string; name: string | null }[];

    let leadsTotal = 0, matchedTotal = 0, campaignsSynced = 0;
    const errors: { campaign: string; error: string }[] = [];
    const warnings: string[] = [];
    const unmappedClientLike: string[] = [];
    for (const cm of campRows) {
      const client = mapCampaign(cm.name, cm.bison_id);
      if (!client) {
        // the "Client + Sender + Market" shape marks real client campaigns; others are internal
        if ((cm.name ?? "").includes(" + ")) unmappedClientLike.push(cm.name!);
        continue;
      }
      try {
        const leads = await fetchCampaignLeads(key, base, cm.bison_id);
        const existing = (await pool.query(
          "select count(*)::int n from bison_client_leads where campaign_id = $1", [cm.bison_id]
        )).rows[0].n as number;
        if (leads.length === 0 && existing > 0) {
          // an empty response over previously-populated rows is more likely an API hiccup than
          // a genuinely emptied campaign — keep the old rows and surface it
          warnings.push(`${cm.name ?? cm.bison_id}: empty response, kept ${existing} existing rows`);
          continue;
        }
        const emails = [...new Set(leads.map((l) => l.email))];
        const matched = new Map<string, string>();
        if (emails.length) {
          // preferred email outranks enriched; order by id makes ambiguous emails deterministic
          const pref = await pool.query(
            "select id, lower(preferred_email) e from agents where lower(preferred_email) = any($1) order by id", [emails]);
          for (const r of pref.rows) if (!matched.has(r.e)) matched.set(r.e, r.id);
          const rest = emails.filter((e) => !matched.has(e));
          if (rest.length) {
            const enr = await pool.query(
              "select id, lower(enriched_email) e from agents where lower(enriched_email) = any($1) order by id", [rest]);
            for (const r of enr.rows) if (!matched.has(r.e)) matched.set(r.e, r.id);
          }
          // agent-provided emails lead campaign sends since C3 — leads created with them
          // must map back to the same agent
          const rest2 = emails.filter((e) => !matched.has(e));
          if (rest2.length) {
            const prov = await pool.query(
              "select id, lower(source_ids->'agent_provided'->>'email') e from agents where lower(source_ids->'agent_provided'->>'email') = any($1) order by id", [rest2]);
            for (const r of prov.rows) if (!matched.has(r.e)) matched.set(r.e, r.id);
          }
        }
        const dbc = await pool.connect();
        try {
          await dbc.query("begin");
          // Carry `replied`/`bounced` across the replace below.
          //
          // The replace re-creates every row for this campaign and both flags default to false,
          // but the sweeps that set them run only AFTER the whole campaign loop. Without this
          // carry-over the flags read false for the 10-15 minutes the mirror takes to rebuild, so
          // the Replied filter, column and sort silently under-report for the entire window --
          // measured live at 2,731 replied rows draining to 501 mid-sync before recovering.
          //
          // Bounced is worse than replied: its sweep goes incremental whenever ANY bounced row
          // survives the loop (a campaign that errored or returned empty keeps its rows), and an
          // incremental pass only ADDS flags. Bounces wiped by the replace are then never
          // restored. Carrying the flags keeps the mirror correct at every instant; the
          // end-of-run sweeps still reconcile in both directions, so nothing is pinned stale.
          // Looked up by EMAIL across the whole table, not just this campaign, because that is
          // what both sweeps mean by the flags: each matches `email = any(...)` with no campaign
          // scoping, so a reply or a bounce belongs to the address, not to one campaign's row.
          // 32,182 emails sit in more than one campaign here, and leads get moved between them,
          // so a per-campaign lookup would drop the flag every time that happened.
          const prev = emails.length
            ? await dbc.query(
                `select email, bool_or(replied) replied, bool_or(bounced) bounced
                   from bison_client_leads
                  where email = any($1::text[]) and (replied or bounced)
                  group by email`,
                [emails]
              )
            : { rows: [] };
          const prevFlags = new Map<string, { replied: boolean; bounced: boolean }>(
            (prev.rows as { email: string; replied: boolean; bounced: boolean }[]).map((r) => [
              r.email,
              { replied: r.replied, bounced: r.bounced },
            ])
          );
          // a campaign belongs to exactly one client — a rename/re-point moves its rows
          await dbc.query("delete from bison_client_leads where campaign_id = $1", [cm.bison_id]);
          if (leads.length) {
            const seen = new Set<string>();
            const rows = leads.filter((l) => (seen.has(l.email) ? false : (seen.add(l.email), true)))
              .map((l) => ({
                email: l.email,
                bison_lead_id: l.bison_lead_id,
                agent_id: matched.get(l.email) ?? null,
                replied: prevFlags.get(l.email)?.replied ?? false,
                bounced: prevFlags.get(l.email)?.bounced ?? false,
              }));
            await dbc.query(
              `insert into bison_client_leads (client_id, campaign_id, campaign_name, bison_lead_id, email, agent_id, replied, bounced)
               select $1, $2, $3, x.bison_lead_id, x.email, x.agent_id, x.replied, x.bounced
                 from jsonb_to_recordset($4::jsonb) as x(bison_lead_id text, email text, agent_id uuid, replied boolean, bounced boolean)`,
              [client.id, cm.bison_id, cm.name, JSON.stringify(rows)]
            );
            leadsTotal += rows.length;
            matchedTotal += rows.filter((r) => r.agent_id).length;
          }
          await dbc.query("commit");
          campaignsSynced++;
        } catch (e) {
          await dbc.query("rollback").catch(() => {});
          throw e;
        } finally {
          dbc.release();
        }
      } catch (e) {
        errors.push({ campaign: cm.name ?? cm.bison_id, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // campaigns deleted from Bison entirely: their rows are no longer membership anywhere
    const liveIds = campRows.map((c) => c.bison_id);
    const purged = await pool.query(
      "delete from bison_client_leads where campaign_id <> all($1::text[])", [liveIds]
    );

    // C4: which leads have EVER replied — one paginated sweep of the workspace-global
    // replied filter, then flag our mirrored rows.
    //
    // NOTE ON PAGE SIZE: this endpoint IGNORES per_page and serves 15 rows a page regardless, so
    // the old 500-page cap was 7,500 leads, not 50,000. At 3,755 replied leads today (251 pages)
    // that headroom was under 2x. Exceeding the cap did NOT throw -- the loop just ended -- and
    // the update below then CLEARED replied for every lead past the cut. Raised to the bounce
    // sweep's 2,000 and made incomplete pagination an error, because a truncated list must never
    // reach an UPDATE that treats absence as "no longer replied".
    //
    // RETRIES, because one bad page aborts the whole sweep. 15 rows a page means ~251 sequential
    // requests, and on 2026-08-18 a single HTTP 500 partway through killed the run: the audit row
    // read "0 replied ... WARN: replied sweep failed: replied sweep 500" while the endpoint
    // answered 200 on every manual attempt minutes later. Nothing was lost -- the throw is what
    // stops a partial list reaching the UPDATE below -- but Bison's replies simply did not refresh
    // for that cycle. Four attempts with a rising delay turns a blip into a non-event, and a real
    // outage still fails loudly rather than clearing flags.
    let repliedTotal = 0;
    try {
      const repliedEmails: string[] = [];
      let complete = false;
      type RepliedPage = { data?: { email?: string }[]; meta?: { last_page?: number } };
      const repliedPage = async (page: number, attempt = 1): Promise<RepliedPage> => {
        try {
          const res = await fetch(
            `${base.replace(/\/+$/, "")}/leads?filters[lead_campaign_status]=replied&pagination_type=length_aware&per_page=100&page=${page}`,
            { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(30000) }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return await res.json();
        } catch (e) {
          if (attempt < 4) {
            await new Promise((r) => setTimeout(r, 1000 * attempt));
            return repliedPage(page, attempt + 1);
          }
          throw new Error(`replied sweep page ${page} after 4 attempts: ${e instanceof Error ? e.message : String(e)}`);
        }
      };
      for (let page = 1; page <= 2000; page++) {
        const j = await repliedPage(page);
        const data: { email?: string }[] = Array.isArray(j?.data) ? j.data : [];
        for (const l of data) {
          const e = String(l.email ?? "").trim().toLowerCase();
          if (e.includes("@")) repliedEmails.push(e);
        }
        const lastPage = j?.meta?.last_page as number | undefined;
        if (data.length === 0 || (lastPage && page >= lastPage)) { complete = true; break; }
        if (!lastPage && data.length >= 100) throw new Error("replied sweep: pagination shape unknown");
      }
      if (!complete) throw new Error("replied sweep: page cap hit — refusing to clear flags from a truncated list");
      repliedTotal = repliedEmails.length;
      // RETIRED 2026-09 (client): replies now come from MasterInbox via
      // /api/cron/masterinbox-replies -> agent_replies, which is append-only. This UPDATE is the
      // line that made a deleted campaign un-reply an agent: absence from the sweep cleared the
      // flag, and the mirror row itself is pruned when its campaign disappears. Left in place,
      // commented, because the client may want the sequencer path back.
      //   await pool.query("update bison_client_leads set replied = (email = any($1::text[])) where replied is distinct from (email = any($1::text[]))", [repliedEmails]);
    } catch (e) {
      warnings.push(`replied sweep failed: ${e instanceof Error ? e.message : "error"}`);
    }

    // C1: bounced sweep — reads LEADS Bison marks bounced, not bounce MESSAGES.
    //
    // This used to page /replies?folder=bounced and take `lead.email ?? primary_to_email_address`.
    // A bounce there is a Delivery Status Notification FROM mailer-daemon TO our own sending
    // mailbox, and `lead` is null on most of them, so the fallback collected OUR SENDER ADDRESSES.
    // Measured over 300 messages: 10 real lead emails, 170 distinct sender addresses. Those
    // addresses match no lead, so the sweep flagged almost nothing -- and on the full-reconcile
    // path it would have CLEARED every genuine flag, since real bounced leads were absent from
    // the list it built. The folder also carries "(Delay)" notices, which are not bounces.
    //
    // filters[verification_statuses][]=bounced returns the leads themselves, which is the thing
    // we actually want: 4,072 leads today vs 21,705 message rows. Every one of the 10 real lead
    // emails found above is in that set, and all 118 flags that survived in our mirror were
    // confirmed by it, with 0 contradictions.
    //
    // Offset pagination here has no server-side cursor state (pages verified distinct,
    // repeatable, and concurrent-consistent), so pages are fetched CONCURRENTLY: 272 pages at 15
    // rows each is ~2 minutes at 8 at a time, against ~16 sequential.
    let bouncedTotal = 0;
    try {
      const root = base.replace(/\/+$/, "");
      // Retries because ONE failed page aborts the whole sweep (a partial list must not reach the
      // reconcile), and over 272 pages a single transient error would otherwise be routine.
      const bouncedPage = async (n: number, attempt = 1): Promise<{ rows: { email?: string }[]; lastPage?: number }> => {
        const url = `${root}/leads?filters%5Bverification_statuses%5D%5B%5D=bounced&pagination_type=length_aware&per_page=100&page=${n}`;
        try {
          const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = await res.json();
          // an error-in-200 arrives as an OBJECT under data; it must not read as "no bounces"
          if (!Array.isArray(j?.data)) throw new Error(JSON.stringify(j?.data).slice(0, 120));
          return { rows: j.data, lastPage: j?.meta?.last_page as number | undefined };
        } catch (e) {
          if (attempt < 4) {
            await new Promise((r) => setTimeout(r, 1000 * attempt));
            return bouncedPage(n, attempt + 1);
          }
          throw new Error(`bounce sweep page ${n} after 4 attempts: ${e instanceof Error ? e.message : String(e)}`);
        }
      };

      const first = await bouncedPage(1);
      const lastPage = first.lastPage ?? 1;
      if (lastPage > 5000) throw new Error(`bounce sweep: ${lastPage} pages, refusing`);
      const set = new Set<string>();
      const collect = (rows: { email?: string }[]) => {
        for (const l of rows) {
          const e = String(l.email ?? "").trim().toLowerCase();
          if (e.includes("@")) set.add(e);
        }
      };
      collect(first.rows);

      const queue: number[] = [];
      for (let n = 2; n <= lastPage; n++) queue.push(n);
      const failures: string[] = [];
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          while (queue.length) {
            const n = queue.shift()!;
            try {
              collect((await bouncedPage(n)).rows);
            } catch (e) {
              failures.push(e instanceof Error ? e.message : String(e));
            }
          }
        })
      );
      // a partial list must never reach the reconcile below — absence means "not bounced" there
      if (failures.length) throw new Error(`${failures.length} page(s) failed, e.g. ${failures[0]}`);

      const bouncedEmails = [...set];
      bouncedTotal = bouncedEmails.length;
      // Now that the list is the authoritative set of bounced leads rather than a sample of
      // notification recipients, a two-way reconcile is correct: it adds new bounces and clears
      // any lead Bison no longer considers bounced. The old incremental branch existed only
      // because the list could not be trusted to be complete.
      await pool.query(
        "update bison_client_leads set bounced = (email = any($1::text[])) where bounced is distinct from (email = any($1::text[]))",
        [bouncedEmails]
      );
    } catch (e) {
      warnings.push(`bounce sweep failed: ${e instanceof Error ? e.message : "error"}`);
    }

    const summary = {
      campaignsSynced,
      leads: leadsTotal,
      matched: matchedTotal,
      replied: repliedTotal,
      bounced: bouncedTotal,
      errors,
      warnings,
      unmappedClientLike,
      purgedDeletedCampaignRows: purged.rowCount ?? 0,
    };
    await pool.query(
      `insert into audit_logs (action, performed_by, details) values ('bison_lead_sync', 'cron',
       $1)`,
      [`synced ${campaignsSynced} campaigns, ${leadsTotal} leads (${matchedTotal} matched), ` +
       `${repliedTotal} replied / ${bouncedTotal} bounced seen` +
       (errors.length ? ` — ${errors.length} FAILED: ${errors.map((e) => e.campaign).slice(0, 5).join(", ")}` : "") +
       // warnings used to be computed and dropped, which is why a failing sweep left no trace
       // anywhere: "replied sweep failed" and "bounce sweep failed" both land here, and both mean
       // the flags did not get reconciled on this run.
       (warnings.length ? ` — WARN: ${warnings.slice(0, 5).join("; ")}` : "") +
       (unmappedClientLike.length ? ` — unmapped: ${unmappedClientLike.slice(0, 5).join(", ")}` : "")]
    ).catch((e: unknown) => console.error("bison_lead_sync audit write failed:", e instanceof Error ? e.message : e));

    void summary; // the fields above are the ones worth persisting; the rest is for the HTTP body
    } finally {
      await lockConn.query("select pg_advisory_unlock(hashtext('bison-lead-sync'))").catch(() => {});
      lockConn.release();
    }
}

export async function POST(req: NextRequest) {
  return handle(req);
}
export async function GET(req: NextRequest) {
  return handle(req);
}
