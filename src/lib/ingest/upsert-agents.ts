// Canonical agent ingest: upsert a batch of Courted-shaped rows into agents +
// agent_source_stats + offices + mls + junctions. Used by /api/ingest/agents
// (scraper webhook). Rows are keyed by the Courted CSV column names.
//
// BULK design: the whole batch is processed with a fixed, small number of
// set-based SQL statements (not ~5 queries per row), so throughput no longer
// depends on per-row round-trips to the (cross-region) DB. New rows get a
// client-generated UUID so inserts don't need RETURNING-order mapping.
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

type Row = Record<string, unknown>;

const txt = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const money = (v: unknown): number | null => {
  const s = txt(v);
  if (s == null) return null;
  const n = parseFloat(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const pct = (v: unknown): number | null => {
  const s = txt(v);
  if (s == null) return null;
  const n = parseFloat(s.replace(/%/g, ""));
  return Number.isFinite(n) ? n : null;
};
const intval = (v: unknown): number | null => {
  const s = txt(v);
  if (s == null) return null;
  const n = parseInt(s.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};
const num = (v: unknown): number | null => {
  const s = txt(v);
  if (s == null) return null;
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const yn = (v: unknown): boolean | null => {
  const s = txt(v);
  if (s == null) return null;
  if (/^yes$/i.test(s)) return true;
  if (/^no$/i.test(s)) return false;
  return null;
};
const lower = (v: unknown): string | null => {
  const s = txt(v);
  return s == null ? null : s.toLowerCase();
};
const digits = (v: unknown): string | null => {
  const s = txt(v);
  return s == null ? null : s.replace(/[^0-9]/g, "");
};
// Both flags can be set on the same agent (1,798 today), so emit BOTH roles rather than letting
// Managing Broker mask Team Leader — the old either/or is why those combined rows were one sweep
// away from losing half their title. Canonical order matches fn_effective_title.
const deriveTitle = (r: Row): string => {
  const roles = [yn(r["Is Managing Broker"]) && "Managing Broker", yn(r["Is Team Leader"]) && "Team Leader"].filter(Boolean);
  return roles.length ? roles.join(", ") : "Salesperson";
};

// "23 years 8 months of experience" / "22" -> months
function yearsToMos(raw: unknown): number | undefined {
  const s = txt(raw);
  if (!s) return undefined;
  const y = /(\d+)\s*year/i.exec(s);
  const m = /(\d+)\s*month/i.exec(s);
  if (!y && !m) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n * 12 : undefined;
  }
  return (y ? +y[1] : 0) * 12 + (m ? +m[1] : 0);
}
// "$756K" / "$1.2M" / "1,250,000" -> 756000 / 1200000 / 1250000
function expandMoney(raw: unknown): number | undefined {
  const s = txt(raw);
  if (!s) return undefined;
  const m = /([\d.]+)\s*([KkMmBb]?)/.exec(s.replace(/[$,]/g, ""));
  if (!m) return undefined;
  let n = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  if (u === "K") n *= 1e3;
  else if (u === "M") n *= 1e6;
  else if (u === "B") n *= 1e9;
  return Number.isFinite(n) ? Math.round(n) : undefined;
}
// "English, Spanish; Portuguese / French" -> ["English","Spanish","Portuguese","French"]
function splitList(raw: unknown): string[] | undefined {
  const s = txt(raw);
  if (!s) return undefined;
  const arr = s.split(/[,;|/]/).map((x) => x.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
}
// Translate a Realtor/Zillow row into the canonical Courted-style keys the upsert reads,
// so the scraper can POST each source's native columns. (Courted rows pass through.)
// Field policy (spec CSV "Zillow_Realtor.com vs Courted - Fields"):
//   merged=Yes  -> canonical Courted keys (Name, Office, Email, tenure, City->Most Transacted…)
//   merged=No   -> their own keys (LinkedIn, all-time stats, languages…) — separate columns,
//                  because these are ALL-TIME numbers vs Courted's last-12-months metrics.
function remapRow(raw: Row, source: string): Row {
  if (source === "realtor") {
    return {
      "Name": raw["Name"], "First Name": raw["First Name"], "Last Name": raw["Last Name"],
      "State License": raw["License Number"],
      "Email": raw["Email"], "Phone": raw["Phone"], "Mobile Phone": raw["Mobile Phone"],
      "Office": raw["Office"],
      "Office City": raw["Office City"], "Office State": raw["Office State"], "Office Zip": raw["Office Postal"], "Office Address": raw["Office Address"],
      "Most Transacted City": raw["City"],
      "Years Of Experience": raw["Years Of Experience"],
      "Agent Tenure (mos)": yearsToMos(raw["Years Of Experience"]),
      "LTM Closed Transactions": raw["Sales Count Last Year"],
      "Active Listings": raw["For Sale Count"],
      "Profile Photo URL": raw["Profile Photo URL"],
      "Profile URL": raw["Realtor Profile URL"] ?? raw["Profile URL"],
      "LinkedIn URL": raw["LinkedIn URL"] ?? raw["LinkedIn"] ?? raw["Linkedin"],
      "Languages Spoken": raw["Languages Spoken"] ?? raw["Languages"],
      "Total Sales All Time": raw["Total Sales"] ?? raw["Total Sales Count"],
      "Average Price All Time": expandMoney(raw["Average Price All Time"] ?? raw["Average Price"]),
      "Average Sales Volume All Time": expandMoney(raw["Average Sales Volume All Time"] ?? raw["Average Sales Volume"]),
      "Price Range": raw["Price Range"],
      "Other Licenses": raw["Other licenses"] ?? raw["Other Licenses"] ?? raw["All Licenses"],
    };
  }
  if (source === "zillow") {
    return {
      "Name": raw["Name"],
      "State License": raw["License Number"],
      "Email": raw["Email"], "Phone": raw["Phone"],
      "Office": raw["Brokerage"], "Office Address": raw["Brokerage Address"],
      // Zillow's City/State/Zip = the agent's service area -> Most Transacted (spec). They also
      // key/describe the OFFICE row (so brokerages stay partitioned per metro instead of one
      // nationwide mega-office); prepare() keeps them OFF the agent's own office_* columns.
      "Most Transacted City": raw["City"], "Most Transacted State": raw["State"], "Most Transacted Zip": raw["Zip Code"],
      "Office City": raw["City"], "Office State": raw["State"], "Office Zip": raw["Zip Code"],
      "Years Of Experience": raw["Years of Experience"],
      "Agent Tenure (mos)": yearsToMos(raw["Years of Experience"]),
      "LTM Closed Transactions": raw["Sales Count Last Year"],
      "Active Listings": raw["Active Listings Count"],
      "Profile Photo URL": raw["Profile Photo URL"],
      "Profile URL": raw["Zillow Profile URL"],
      "LinkedIn URL": raw["LinkedIn URL"],
      "Languages Spoken": raw["Languages Spoken"],
      "Total Sales All Time": raw["Total Sales Count"],
      "Average Price All Time": expandMoney(raw["Average Price"]), // all-time — kept OUT of LTM avg sale price
      "Average Sales Volume All Time": expandMoney(raw["Average Sales Volume"]),
      "Other Licenses": raw["All Licenses"],
    };
  }
  return raw; // courted: already canonical
}

function matchKey(license: string | null, email: string | null, phone: string | null, fullName: string | null, officeZip: string | null): [string, string] {
  if (license) return [`lic:${license.toLowerCase()}`, "high"];
  if (email) return [`email:${email.toLowerCase()}`, "high"];
  if (phone) return [`phone:${digits(phone)}`, "high"];
  return [`name:${(fullName || "").toLowerCase()}|${(officeZip || "").toLowerCase()}`, "low"];
}

// ---- column specs shared by insert + update (name must match the JS object keys) ----
const AGENT_COLS: [string, string][] = [
  ["full_name", "text"], ["first_name", "text"], ["last_name", "text"], ["license_number", "text"],
  ["preferred_email", "text"], ["preferred_phone", "text"], ["brand", "text"], ["office_name", "text"], ["office_id", "uuid"],
  ["est_time_in_industry_months", "numeric"], ["est_time_in_industry_raw", "text"],
  ["est_time_at_office_months", "numeric"], ["avg_time_at_office_months", "numeric"],
  ["home_city", "text"], ["home_zip", "text"], ["home_state", "text"], ["home_address", "text"],
  ["office_city", "text"], ["office_zip", "text"], ["office_state", "text"],
  ["most_transacted_city", "text"], ["most_transacted_zip", "text"], ["transacted_state", "text"],
  ["sales_volume", "numeric"], ["pct_change", "numeric"], ["buy_side_dollar", "numeric"], ["list_side_dollar", "numeric"],
  ["approx_gci", "numeric"], ["avg_sale_price", "numeric"], ["closed_transactions", "numeric"], ["units", "numeric"],
  ["buy_side_count", "numeric"], ["list_side_count", "numeric"], ["closed_rentals", "numeric"], ["avg_rental_price", "numeric"],
  ["active_listings", "integer"], ["pending_listings", "integer"], ["title", "text"],
  ["linkedin_url", "text"], ["languages", "text[]"], ["total_sales_all_time", "numeric"],
  ["avg_price_all_time", "numeric"], ["avg_sales_volume_all_time", "numeric"],
  ["price_range", "text"], ["other_licenses", "text"],
  ["match_key", "text"], ["match_confidence", "text"],
];
// Zillow/Realtor-only columns (spec: merged=No) — those sources own them; new value wins.
const SOURCE_ONLY_COLS = new Set([
  "linkedin_url", "languages", "total_sales_all_time", "avg_price_all_time",
  "avg_sales_volume_all_time", "price_range", "other_licenses",
]);
// Spec merged=Yes fields: on a CROSS-SOURCE match these only FILL BLANKS — Courted stays the
// primary source; the incoming source's own values are kept in source_ids for the breakdown.
const MERGE_FILL_COLS = new Set([
  "full_name", "first_name", "last_name", "license_number", "preferred_email", "preferred_phone",
  "brand", "office_name", "office_id", "office_city", "office_zip", "office_state",
  "est_time_in_industry_months", "est_time_in_industry_raw",
  "most_transacted_city", "most_transacted_zip", "transacted_state",
  "closed_transactions", "active_listings",
]);
const STAT_COLS: [string, string][] = [
  ["sales_volume", "numeric"], ["prev_sales_volume", "numeric"], ["pct_change", "numeric"], ["approx_gci", "numeric"],
  ["avg_sale_price", "numeric"], ["closed_transactions", "numeric"], ["units", "numeric"], ["buy_side_count", "numeric"],
  ["list_side_count", "numeric"], ["buy_side_dollar", "numeric"], ["list_side_dollar", "numeric"],
  ["avg_sale_price_buy_side", "numeric"], ["avg_sale_price_list_side", "numeric"], ["close_to_list_pct", "numeric"],
  ["avg_days_on_market", "integer"], ["closed_rentals", "numeric"], ["avg_rental_price", "numeric"],
];
const recordset = (cols: [string, string][], leadName: string, leadType: string) =>
  `${leadName} ${leadType}, ` + cols.map(([n, t]) => `${n} ${t}`).join(", ");

const OKEY = (brand: string | null, name: string | null, zip: string | null) => JSON.stringify([brand, name, zip]);

export interface IngestResult {
  inserted: number;
  updated: number;
  offices: number;
  mls: number;
  // every agent id this batch touched (inserted + updated) — callers that link agents to a
  // client (CSV import with a client selected) need them; API responses strip this field.
  agentIds: string[];
}

interface Prepared {
  officeKey: string | null;
  officeName: string | null;
  brand: string | null;
  officeCity: string | null;
  officeState: string | null;
  officeZip: string | null;
  officeAddress: string | null;
  mlsCode: string | null;
  mlsName: string | null;
  mlsState: string | null;
  memberId: string | null;
  sid: string | null;
  license: string | null;
  email: string | null;
  phoneKey: string | null;
  agent: Record<string, unknown>;
  stat: Record<string, unknown>;
  courted: Record<string, unknown>;
}

export async function upsertAgentRows(client: PoolClient, rows: Row[], source: string): Promise<IngestResult> {
  const stats: IngestResult = { inserted: 0, updated: 0, offices: 0, mls: 0, agentIds: [] };
  if (!rows.length) return stats;

  // ---- 1) prepare every row in JS (pure, no DB) ----
  const prepared: Prepared[] = rows.map((_raw) => {
    const r = remapRow(_raw, source);
    const brand = txt(r["Brand"]);
    const officeName = txt(r["Custom Office Name"]) || txt(r["Office"]);
    const officeCity = txt(r["Office City"]);
    const officeState = txt(r["Office State"]);
    const officeZip = txt(r["Office Zip"]);
    const officeAddress = txt(r["Office Address"]);
    // A valid MLS code is a short identifier (CMLS, GAMLS…) — imports have leaked profile
    // URLs and bare numbers into this column, which used to create junk mls rows.
    const rawMlsCode = txt(r["MLS ID"]);
    const mlsCode = rawMlsCode && /^[A-Za-z][A-Za-z0-9 &.\-]{1,19}$/.test(rawMlsCode) ? rawMlsCode : null;
    const fullName = txt(r["Name"]);
    const license = txt(r["State License"]);
    const email = lower(r["Email"]);
    const phone = txt(r["Phone"]);
    const [mkey, mconf] = matchKey(license, email, phone, fullName, officeZip);

    const courtedRaw: Record<string, unknown> = {
      agent_id: txt(r["Courted Agent ID"]),
      id: txt(r["Courted ID"]),
      profile_url: txt(r["Courted Profile URL"]) || txt(r["Profile URL"]),
      profile_photo_url: txt(r["Profile Photo URL"]),
      // every source keeps its OWN contact/city/office values here, so the app can show both
      // values when sources differ AND campaign sends can resolve fields by source priority.
      email: email || undefined,
      phone: phone || undefined,
      city: txt(r["Most Transacted City"]),
      office_name: officeName || undefined,
      nickname: txt(r["Nickname"]),
      mobile_phone: txt(r["Mobile Phone"]) && txt(r["Mobile Phone"]) !== phone ? txt(r["Mobile Phone"]) : undefined,
      is_new_agent: yn(r["Is New Agent"]),
      is_team_leader: yn(r["Is Team Leader"]),
      is_team_member: yn(r["Is Team Member"]),
      is_managing_broker: yn(r["Is Managing Broker"]),
      is_rental_agent: yn(r["Is Rental Agent"]),
      likelihood_to_move: txt(r["Likelihood To Move"]),
      future_growth_tag: txt(r["Future Growth Tag"]),
      forecast_segment: txt(r["Forecast Segment"]),
      ai_agent_type: txt(r["AI Agent Type"]),
      ytd_sales_volume: money(r["YTD Sales Volume"]),
      ytd_units: intval(r["YTD Units"]),
      ytd_avg_sale_price: money(r["YTD Avg Sale Price"]),
      alt_state_licenses: txt(r["Alt State Licenses"]),
    };
    const courted = Object.fromEntries(Object.entries(courtedRaw).filter(([, v]) => v !== undefined && v !== null));

    const agent: Record<string, unknown> = {
      full_name: fullName, first_name: txt(r["First Name"]), last_name: txt(r["Last Name"]),
      license_number: license, preferred_email: email, preferred_phone: phone,
      brand, office_name: officeName, office_id: null, // resolved below
      est_time_in_industry_months: num(r["Agent Tenure (mos)"]),
      est_time_in_industry_raw: txt(r["Years Of Experience"]),
      est_time_at_office_months: num(r["Time At Current Office (mos)"]),
      avg_time_at_office_months: num(r["Avg Time At Office (mos)"]),
      home_city: txt(r["Home City"]), home_zip: txt(r["Home Zip"]), home_state: txt(r["Home State"]), home_address: txt(r["Home Address"]),
      // zillow: officeCity/Zip/State describe the service area (used only for office identity) —
      // the agent's own office location stays unknown per the field spec
      office_city: source === "zillow" ? null : officeCity,
      office_zip: source === "zillow" ? null : officeZip,
      office_state: source === "zillow" ? null : officeState,
      most_transacted_city: txt(r["Most Transacted City"]), most_transacted_zip: txt(r["Most Transacted Zip"]), transacted_state: txt(r["Most Transacted State"]),
      sales_volume: money(r["LTM Sales Volume"]), pct_change: pct(r["Sales Volume Change %"]),
      buy_side_dollar: money(r["LTM Sales Volume Buy-Side"]), list_side_dollar: money(r["LTM Sales Volume List-Side"]),
      approx_gci: money(r["LTM Est GCI"]), avg_sale_price: money(r["LTM Avg Sale Price"]),
      closed_transactions: num(r["LTM Closed Transactions"]), units: num(r["LTM Closed Units"]),
      buy_side_count: num(r["LTM Units Buy-Side"]), list_side_count: num(r["LTM Units List-Side"]),
      closed_rentals: num(r["LTM Rental Count"]), avg_rental_price: money(r["LTM Avg Rental Price"]),
      active_listings: intval(r["Active Listings"]), pending_listings: intval(r["Pending Listings"]),
      linkedin_url: txt(r["LinkedIn URL"]), languages: splitList(r["Languages Spoken"]),
      total_sales_all_time: num(r["Total Sales All Time"]),
      avg_price_all_time: num(r["Average Price All Time"]),
      avg_sales_volume_all_time: num(r["Average Sales Volume All Time"]),
      price_range: txt(r["Price Range"]), other_licenses: txt(r["Other Licenses"]),
      title: deriveTitle(r), match_key: mkey, match_confidence: mconf,
    };
    const stat: Record<string, unknown> = {
      sales_volume: money(r["LTM Sales Volume"]), prev_sales_volume: money(r["Prev LTM Sales Volume"]), pct_change: pct(r["Sales Volume Change %"]),
      approx_gci: money(r["LTM Est GCI"]), avg_sale_price: money(r["LTM Avg Sale Price"]), closed_transactions: num(r["LTM Closed Transactions"]),
      units: num(r["LTM Closed Units"]), buy_side_count: num(r["LTM Units Buy-Side"]), list_side_count: num(r["LTM Units List-Side"]),
      buy_side_dollar: money(r["LTM Sales Volume Buy-Side"]), list_side_dollar: money(r["LTM Sales Volume List-Side"]),
      avg_sale_price_buy_side: money(r["LTM Avg Sale Price Buy-Side"]), avg_sale_price_list_side: money(r["LTM Avg Sale Price List-Side"]),
      close_to_list_pct: pct(r["LTM Close-To-List Price %"]), avg_days_on_market: intval(r["LTM Avg Days On Market"]),
      closed_rentals: num(r["LTM Rental Count"]), avg_rental_price: money(r["LTM Avg Rental Price"]),
    };

    return {
      officeKey: officeName || brand ? OKEY(brand, officeName, officeZip) : null,
      officeName, brand, officeCity, officeState, officeZip, officeAddress,
      mlsCode, mlsName: txt(r["MLS Affiliations"]) || txt(r["MLS Affiliation"]) || txt(r["MLS"]), mlsState: officeState || txt(r["Most Transacted State"]),
      memberId: txt(r["Member MLS ID"]),
      sid: txt(r["Courted ID"]), license, email, phoneKey: digits(phone),
      agent, stat, courted,
    };
  });

  await client.query("begin");
  try {
    // ---- 2) OFFICES (resolve every distinct office to an id) ----
    const officeIdByKey = new Map<string, string>();
    const officeByKey = new Map<string, Prepared>();
    for (const p of prepared) if (p.officeKey && !officeByKey.has(p.officeKey)) officeByKey.set(p.officeKey, p);
    if (officeByKey.size) {
      const keys = [...officeByKey.values()];
      const existing = await client.query(
        `select o.id, o.brand, o.office_name, o.office_zip
           from offices o
           join jsonb_to_recordset($1::jsonb) as v(brand text, name text, zip text)
             on o.brand is not distinct from v.brand and o.office_name is not distinct from v.name and o.office_zip is not distinct from v.zip`,
        [JSON.stringify(keys.map((k) => ({ brand: k.brand, name: k.officeName, zip: k.officeZip })))]
      );
      for (const row of existing.rows) officeIdByKey.set(OKEY(row.brand, row.office_name, row.office_zip), row.id);

      const missing = keys.filter((k) => !officeIdByKey.has(k.officeKey!));
      if (missing.length) {
        const toInsert = missing.map((k) => ({
          id: randomUUID(), brand: k.brand, office_name: k.officeName, office_city: k.officeCity,
          office_state: k.officeState, office_zip: k.officeZip, office_address: k.officeAddress,
        }));
        await client.query(
          `insert into offices (id, brand, office_name, office_city, office_state, office_zip, office_address, sources)
           select x.id, x.brand, x.office_name, x.office_city, x.office_state, x.office_zip, x.office_address, array[$2]::text[]
           from jsonb_to_recordset($1::jsonb) as x(id uuid, brand text, office_name text, office_city text, office_state text, office_zip text, office_address text)`,
          [JSON.stringify(toInsert), source]
        );
        for (const o of toInsert) officeIdByKey.set(OKEY(o.brand, o.office_name, o.office_zip), o.id);
        stats.offices = missing.length;
      }

      // enrich existing offices' location (new value wins, matching prior behaviour)
      const missingKeys = new Set(missing.map((k) => k.officeKey));
      const enrich = keys
        .filter((k) => !missingKeys.has(k.officeKey))
        .map((k) => ({ id: officeIdByKey.get(k.officeKey!), city: k.officeCity, state: k.officeState, address: k.officeAddress }))
        .filter((e) => e.id && (e.city || e.state || e.address));
      if (enrich.length) {
        await client.query(
          `update offices o set office_city = coalesce(x.city, o.office_city), office_state = coalesce(x.state, o.office_state), office_address = coalesce(x.address, o.office_address)
           from jsonb_to_recordset($1::jsonb) as x(id uuid, city text, state text, address text) where o.id = x.id`,
          [JSON.stringify(enrich)]
        );
      }
    }
    for (const p of prepared) p.agent.office_id = p.officeKey ? officeIdByKey.get(p.officeKey) ?? null : null;

    // ---- 3) MLS (upsert distinct codes -> id map) ----
    const mlsIdByCode = new Map<string, string>();
    const distinctMls = new Map<string, Prepared>();
    for (const p of prepared) if (p.mlsCode && !distinctMls.has(p.mlsCode)) distinctMls.set(p.mlsCode, p);
    if (distinctMls.size) {
      // Resolve by current code OR any former code (aliases — codes are admin-editable);
      // only genuinely-new codes insert, and an existing MLS's admin-set name is never
      // overwritten by the scraper.
      const res = await client.query(
        `with incoming as (select x.code, x.name, x.state from jsonb_to_recordset($1::jsonb) as x(code text, name text, state text)),
         matched as (
           select i.code as code, m.id from incoming i
           join mls m on m.code = i.code or i.code = any(m.aliases)
         ),
         ins as (
           insert into mls (code, name, state)
           select i.code, i.name, i.state from incoming i
            where not exists (select 1 from matched mm where mm.code = i.code)
           on conflict (code) do update set state = coalesce(mls.state, excluded.state)
           returning id, code
         )
         select code, id from matched union all select code, id from ins`,
        [JSON.stringify([...distinctMls.values()].map((p) => ({ code: p.mlsCode, name: p.mlsName, state: p.mlsState })))]
      );
      for (const row of res.rows) mlsIdByCode.set(row.code, row.id);
      stats.mls = distinctMls.size;
    }

    // ---- 4) match existing agents in bulk (source-id -> license -> email -> phone) ----
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];
    const bySid = new Map<string, string>(), byLic = new Map<string, string>();
    // low-trust tiers keep EVERY candidate per key — several agents legitimately share an
    // office line (or a team inbox), and the veto picks the compatible one
    const byEmail = new Map<string, string[]>(), byPhone = new Map<string, string[]>();
    // identity fields of every DB candidate, for the merge conflict-veto below
    const dbMeta = new Map<string, { name: string | null; lic: string | null; email: string | null; phone: string | null }>();
    const sids = uniq(prepared.map((p) => p.sid));
    const lics = uniq(prepared.map((p) => p.license));
    const emails = uniq(prepared.map((p) => p.email));
    const phones = uniq(prepared.map((p) => p.phoneKey));
    const remember = (r: { id: string; full_name: string | null; license_number: string | null; em: string | null; ph?: string | null }) =>
      dbMeta.set(r.id, { name: r.full_name, lic: r.license_number, email: r.em, phone: r.ph ?? null });
    if (sids.length) (await client.query(`select id, full_name, license_number, lower(preferred_email) em, preferred_phone_digits ph, source_ids->$2->>'id' k from agents where source_ids->$2->>'id' = any($1::text[])`, [sids, source])).rows.forEach((r) => { if (r.k != null) bySid.set(r.k, r.id); remember(r); });
    if (lics.length) (await client.query(`select id, full_name, license_number, lower(preferred_email) em, preferred_phone_digits ph, license_number k from agents where license_number = any($1::text[])`, [lics])).rows.forEach((r) => { byLic.set(r.k, r.id); remember(r); });
    if (emails.length) (await client.query(`select id, full_name, license_number, lower(preferred_email) em, preferred_phone_digits ph, lower(preferred_email) k from agents where lower(preferred_email) = any($1::text[])`, [emails])).rows.forEach((r) => { byEmail.set(r.k, [...(byEmail.get(r.k) ?? []), r.id]); remember(r); });
    if (phones.length) (await client.query(`select id, full_name, license_number, lower(preferred_email) em, preferred_phone_digits ph, preferred_phone_digits k from agents where preferred_phone_digits = any($1::text[]) and preferred_phone_digits <> ''`, [phones])).rows.forEach((r) => { byPhone.set(r.k, [...(byPhone.get(r.k) ?? []), r.id]); remember(r); });

    // ---- 5) resolve each row to an agent id (in-batch dedup, order-sensitive; last row wins) ----
    const seen = new Map<string, string>(); // sid/license key -> agent id already assigned in this batch
    const seenLow = new Map<string, string[]>(); // email/phone key -> ALL batch claimants (veto picks among them)
    const isNew = new Map<string, boolean>();
    const finalById = new Map<string, Prepared>();
    const statByAgent = new Map<string, Record<string, unknown>>();
    const mlsStatByPair = new Map<string, Record<string, unknown>>();
    const agentMlsByPair = new Map<string, { agent_id: string; mls_id: string; mls_member_id: string | null }>();
    const officeMlsPairs = new Set<string>();
    for (const p of prepared) {
      const idkeys: string[] = [];
      if (p.sid) idkeys.push("s:" + p.sid);
      if (p.license) idkeys.push("l:" + p.license);
      if (p.email) idkeys.push("e:" + p.email);
      if (p.phoneKey) idkeys.push("p:" + p.phoneKey);

      // Resolve by tier in priority order (source-id -> license -> email -> phone). At EACH tier,
      // match against agents already assigned in this batch (seen) OR pre-existing ones (db maps),
      // so a higher tier always wins — a shared office phone can't override a license/email match.
      //
      // CONFLICT VETO (the REBNY 262 lesson): matching a key is not enough when the
      // candidate is CONTRADICTED by stronger evidence. Different license numbers are two
      // different people, always. On the low-trust tiers (email = team inboxes, phone =
      // shared brokerage lines) a merge additionally requires a compatible name — otherwise
      // an identity-poor row folds a whole office into one hybrid record.
      const metaOf = (id: string) => {
        const fp = finalById.get(id);
        if (fp) return { name: (fp.agent.full_name as string) ?? null, lic: fp.license, email: fp.email, phone: fp.phoneKey };
        return dbMeta.get(id) ?? { name: null, lic: null, email: null, phone: null };
      };
      const licConflict = (id: string) => {
        const c = metaOf(id);
        return !!(p.license && c.lic && p.license !== c.lic);
      };
      const nm = (v: string | null) => (v ?? "").toLowerCase().replace(/[^a-z ]/g, "").trim();
      const namesCompatible = (id: string) => {
        const a = nm(p.agent.full_name as string | null), b = nm(metaOf(id).name);
        if (!a || !b) return true; // nothing to contradict
        if (a === b) return true;
        // surname equality (suffixes stripped) — first-name equality alone is NOT enough:
        // two different Johns share office lines all the time
        const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv"]);
        const toks = (x: string) => x.split(/\s+/).filter((t) => !SUFFIX.has(t));
        const at = toks(a), bt = toks(b);
        if (at.length === 0 || bt.length === 0) return true;
        return at.length > 1 && bt.length > 1 && at[at.length - 1] === bt[bt.length - 1] && at[0][0] === bt[0][0];
      };
      const emailConflict = (id: string) => {
        const c = metaOf(id);
        return !!(p.email && c.email && p.email !== c.email);
      };
      const phoneConflict = (id: string) => {
        const c = metaOf(id);
        return !!(p.phoneKey && c.phone && p.phoneKey !== c.phone);
      };
      // POLICY (client-set): on the low-trust tiers, contact info must never contradict —
      // a phone match with differing emails is two people (even with identical names:
      // Courted's second-brokerage-email profiles stay separate), and an email match with
      // differing phones is two people. Same Courted ID / license still merges above.
      const passes = (id: string, tier: "email" | "phone") => {
        if (licConflict(id)) return false; // different license = different person
        if (!namesCompatible(id)) return false; // team inbox / shared line guard
        if (tier === "phone" && emailConflict(id)) return false;
        if (tier === "email" && phoneConflict(id)) return false;
        return true;
      };
      const pickLow = (key: string, dbMap: Map<string, string[]>, raw: string, tier: "email" | "phone") => {
        for (const id of [...(seenLow.get(key) ?? []), ...(dbMap.get(raw) ?? [])]) if (passes(id, tier)) return id;
        return undefined;
      };
      let agentId: string | undefined;
      if (p.sid) agentId = seen.get("s:" + p.sid) ?? bySid.get(p.sid);
      if (!agentId && p.license) agentId = seen.get("l:" + p.license) ?? byLic.get(p.license);
      if (!agentId && p.email) agentId = pickLow("e:" + p.email, byEmail, p.email, "email");
      if (!agentId && p.phoneKey) agentId = pickLow("p:" + p.phoneKey, byPhone, p.phoneKey, "phone");
      if (!agentId) { agentId = randomUUID(); isNew.set(agentId, true); }
      for (const k of idkeys) {
        if (k.startsWith("e:") || k.startsWith("p:")) {
          const arr = seenLow.get(k) ?? [];
          if (!arr.includes(agentId)) seenLow.set(k, [agentId, ...arr]);
        } else seen.set(k, agentId);
      }

      p.agent.id = agentId;
      finalById.set(agentId, p); // last row for this agent wins
      statByAgent.set(agentId, p.stat);
      const mlsId = p.mlsCode ? mlsIdByCode.get(p.mlsCode) : null;
      if (mlsId) {
        agentMlsByPair.set(`${agentId}|${mlsId}`, { agent_id: agentId, mls_id: mlsId, mls_member_id: p.memberId });
        if (p.agent.office_id) officeMlsPairs.add(`${p.agent.office_id}|${mlsId}`);
        // Courted sends one row per (agent, MLS), each with its OWN production block —
        // keep every MLS's metrics, not just the last row's (A5).
        if (source === "courted") mlsStatByPair.set(`${agentId}|${mlsId}`, { agent_id: agentId, mls_id: mlsId, ...p.stat });
      }
    }

    // ---- 6) bulk insert new agents / bulk update matched agents ----
    const agentRecordset = recordset(AGENT_COLS, "id", "uuid");
    const agentSelect = ["x.id", ...AGENT_COLS.map(([n]) => `x.${n}`)].join(", ");
    const toAgentObj = (id: string, p: Prepared) => ({ id, ...p.agent, courted: p.courted });

    const insertRows = [...finalById.entries()].filter(([id]) => isNew.get(id)).map(([id, p]) => toAgentObj(id, p));
    const updateRows = [...finalById.entries()].filter(([id]) => !isNew.get(id)).map(([id, p]) => toAgentObj(id, p));
    stats.inserted = insertRows.length;
    stats.updated = updateRows.length;
    stats.agentIds = [...finalById.keys()];

    // offices an updated agent may be LEAVING (so their agent_count gets recomputed too)
    const recount = new Set<string>(officeIdByKey.values());
    if (updateRows.length) {
      const prevOffices = await client.query(
        `select distinct office_id from agents where id = any($1::uuid[]) and office_id is not null`,
        [updateRows.map((r) => r.id)]
      );
      for (const row of prevOffices.rows) recount.add(row.office_id);
    }

    if (insertRows.length) {
      await client.query(
        `insert into agents (id, ${AGENT_COLS.map(([n]) => n).join(", ")}, sources, source_ids)
         select ${agentSelect}, array[$2]::text[], jsonb_build_object($2, x.courted)
         from jsonb_to_recordset($1::jsonb) as x(${agentRecordset}, courted jsonb)`,
        [JSON.stringify(insertRows), source]
      );
    }
    if (updateRows.length) {
      // Merge policy on matched agents:
      //   courted row        -> authoritative refresh of every field (source-only cols kept)
      //   zillow/realtor row -> merged=Yes fields fill blanks only WHEN the agent has courted
      //                         data (courted stays primary); on a zillow/realtor-ONLY agent a
      //                         re-scrape must refresh normally (new value wins) or the agent
      //                         would be frozen at its first-scrape values forever. Their own
      //                         columns always take the new value, and NOTHING else is touched —
      //                         a Zillow refresh can never null out Courted metrics.
      // metric columns refresh fill-don't-blank: a partial export (some accounts ship only
      // volume+units) must never erase metrics a fuller export delivered (REBNY lesson)
      const METRIC_COLS = new Set([
        "sales_volume", "pct_change", "buy_side_dollar", "list_side_dollar", "approx_gci",
        "avg_sale_price", "closed_transactions", "units", "buy_side_count", "list_side_count",
        "closed_rentals", "avg_rental_price", "active_listings", "pending_listings",
      ]);
      const setClause = AGENT_COLS
        .filter(([n]) => source === "courted" || SOURCE_ONLY_COLS.has(n) || MERGE_FILL_COLS.has(n))
        .map(([n]) => {
          if (SOURCE_ONLY_COLS.has(n)) return `${n} = coalesce(x.${n}, a.${n})`;
          if (source !== "courted" && MERGE_FILL_COLS.has(n)) {
            return `${n} = case when 'courted' = any(coalesce(a.sources, array[]::text[])) then coalesce(a.${n}, x.${n}) else coalesce(x.${n}, a.${n}) end`;
          }
          if (METRIC_COLS.has(n)) return `${n} = coalesce(x.${n}, a.${n})`;
          // A5: a hand-applied Team Leader / Managing Broker tag must survive the sweep. Title
          // is otherwise a full refresh, so an untagged agent takes the derived value exactly as
          // before — the guard keeps the 150k-250k-rows/day common path off the function
          // entirely, and only tagged agents pay for the union.
          if (n === "title") {
            return `title = case when a.source_ids ? 'manual'
                                 then fn_effective_title(x.title, a.source_ids->'manual'->'titles')
                                 else x.title end`;
          }
          return `${n} = x.${n}`;
        })
        .join(", ");
      await client.query(
        `update agents a set ${setClause},
           sources = (select array_agg(distinct s) from unnest(coalesce(a.sources, array[]::text[]) || array[$2]::text[]) s),
           source_ids = coalesce(a.source_ids, '{}'::jsonb) || jsonb_build_object($2, x.courted),
           updated_at = now()
         from jsonb_to_recordset($1::jsonb) as x(${agentRecordset}, courted jsonb) where a.id = x.id`,
        [JSON.stringify(updateRows), source]
      );
    }

    // ---- 7) agent_source_stats (one row per agent, this source) ----
    const statRows = [...statByAgent.entries()].map(([agent_id, s]) => ({ agent_id, ...s }));
    if (statRows.length) {
      await client.query(
        `insert into agent_source_stats (agent_id, source, ${STAT_COLS.map(([n]) => n).join(", ")}, scraped_at)
         select x.agent_id, $2, ${STAT_COLS.map(([n]) => `x.${n}`).join(", ")}, now()
         from jsonb_to_recordset($1::jsonb) as x(${recordset(STAT_COLS, "agent_id", "uuid")})
         on conflict (agent_id, source) do update set ${STAT_COLS.map(([n]) => `${n} = coalesce(excluded.${n}, agent_source_stats.${n})`).join(", ")}, scraped_at = now()`,
        [JSON.stringify(statRows), source]
      );
    }

    // ---- 7b) agent_mls_stats (one row per agent per MLS — A5; courted only, other
    // sources carry no MLS). Same-pair re-ingest refreshes the row in place.
    const mlsStatRows = [...mlsStatByPair.values()];
    if (mlsStatRows.length) {
      await client.query(
        `insert into agent_mls_stats (agent_id, mls_id, ${STAT_COLS.map(([n]) => n).join(", ")}, scraped_at)
         select x.agent_id, x.mls_id, ${STAT_COLS.map(([n]) => `x.${n}`).join(", ")}, now()
         from jsonb_to_recordset($1::jsonb) as x(agent_id uuid, mls_id uuid, ${STAT_COLS.map(([n, t]) => `${n} ${t}`).join(", ")})
         on conflict (agent_id, mls_id) do update set ${STAT_COLS.map(([n]) => `${n} = coalesce(excluded.${n}, agent_mls_stats.${n})`).join(", ")}, scraped_at = now()`,
        [JSON.stringify(mlsStatRows)]
      );
      // A5 rollup (client-approved): agents.* becomes the sum across MLSs — but only for
      // agents whose EVERY membership now has a stats row, so figures never dip mid-fill.
      await client.query(`select fn_rollup_agent_stats($1::uuid[])`, [stats.agentIds]);
    }

    // ---- 8) junctions ----
    const amls = [...agentMlsByPair.values()];
    if (amls.length) {
      await client.query(
        `insert into agent_mls (agent_id, mls_id, mls_member_id)
         select x.agent_id, x.mls_id, x.mls_member_id from jsonb_to_recordset($1::jsonb) as x(agent_id uuid, mls_id uuid, mls_member_id text)
         on conflict (agent_id, mls_id) do update set mls_member_id = excluded.mls_member_id`,
        [JSON.stringify(amls)]
      );
    }
    const omls = [...officeMlsPairs].map((s) => { const [office_id, mls_id] = s.split("|"); return { office_id, mls_id }; });
    if (omls.length) {
      await client.query(
        `insert into office_mls (office_id, mls_id)
         select x.office_id, x.mls_id from jsonb_to_recordset($1::jsonb) as x(office_id uuid, mls_id uuid) on conflict do nothing`,
        [JSON.stringify(omls)]
      );
    }

    // ---- 9) keep office.agent_count + aggregate metrics in sync for touched offices ----
    // (office-level sales figures aren't in the source, so they're summed from the office's
    // agents; recomputed for every office an agent joined or left this batch)
    const touched = [...recount];
    if (touched.length) {
      await client.query(
        `update offices o set
           agent_count      = s.n,
           sales_volume     = s.sales_volume,
           list_side_dollar = s.list_side_dollar,
           buy_side_dollar  = s.buy_side_dollar,
           units            = s.units
         from (
           select o2.id,
                  count(a.id) as n,
                  coalesce(sum(a.sales_volume), 0)     as sales_volume,
                  coalesce(sum(a.list_side_dollar), 0) as list_side_dollar,
                  coalesce(sum(a.buy_side_dollar), 0)  as buy_side_dollar,
                  coalesce(sum(a.units), 0)            as units
             from offices o2 left join agents a on a.office_id = o2.id
            where o2.id = any($1::uuid[]) group by o2.id
         ) s
        where o.id = s.id`,
        [touched]
      );
    }

    // ---- 10) per-MLS freshness (A8): restamp the touched MLSs' last-touched /
    // bulk-refresh dates from the just-written scraped_at values
    const touchedMls = [...new Set([...agentMlsByPair.values()].map((x) => x.mls_id))];
    if (touchedMls.length) {
      await client.query(`select fn_refresh_mls_freshness($1::uuid[])`, [touchedMls]);
    }

    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
  return stats;
}
