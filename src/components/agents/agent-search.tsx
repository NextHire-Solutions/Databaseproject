"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { Agent, SearchResponse, SortDir, SearchMode, DataSource } from "@/types/agent";
import { RangePopover, TitlePopover, ClientPopover, ZillowRealtorPopover, ContactPopover, SavedViewsPopover } from "./agent-filters";
import { LocationPopover, OfficeSearchPopover, MlsPopover, LicensePopover, NamePopover } from "./agent-typeahead-filters";
import { ExportDialog } from "./export-dialog";
import { SavedViews } from "./saved-views";
import { EditColumnsModal } from "./edit-columns";
import { AgentProfileDialog } from "./agent-profile";
import { AllFiltersDrawer } from "./all-filters-drawer";
import { DEFAULT_FILTERS, SALES_VOLUME_BUCKETS, COUNT_BUCKETS, PLACE_COUNT_BUCKETS, activeFilterCount, normalizeFilters } from "@/types/agent-filters";
import type { Filters } from "@/types/agent-filters";
import { useNameSearch } from "@/lib/stores/name-search";

const PAGE_SIZES = [20, 50, 100];
// Ceiling for a single search request. Comfortably above the slowest real filter (the location
// EXCLUDE path is ~8 s) but finite, so a stalled request can't leave the spinner running with
// nothing to end it. On expiry the attempt is abandoned and retried once; see fetchData.
const REQUEST_TIMEOUT_MS = 45_000;

// ---------- formatters ----------
function usdShort(n: number | null | undefined): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  const f = (v: number, d: number) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (a >= 1e9) return `$${f(n / 1e9, 1)}B`; // "$1,426.1B"
  if (a >= 1e6) return `$${f(n / 1e6, 1)}M`;
  if (a >= 1e3) return `$${f(n / 1e3, 0)}K`;
  return `$${f(n, 0)}`;
}
const usd = (n: number | null | undefined) => (n == null ? "N/A" : "$" + Math.round(n).toLocaleString());
const numv = (n: number | null | undefined) => (n == null ? "N/A" : n.toLocaleString());
const na = (s: string | null | undefined) => (s == null || s === "" ? "N/A" : s);
const phoneFmt = (s: string | null | undefined) => (s == null || s === "" ? "None" : s);
// Does this agent match the top-bar search term? The term may be a name, an email, or a
// phone number — the matching column is the one that gets the green highlight.
function searchHit(a: Agent, term: string): "agent" | "email" | "phone" | null {
  const t = term.trim();
  if (!t) return null;
  if (t.includes("@")) {
    const q = t.toLowerCase();
    const ids = (a.source_ids ?? {}) as Record<string, { email?: string | null } | undefined>;
    const mails = [a.preferred_email, a.enriched_email, ids.agent_provided?.email];
    return mails.some((m) => typeof m === "string" && m.toLowerCase().includes(q)) ? "email" : null;
  }
  const digits = t.replace(/\D/g, "");
  if (digits.length >= 7) {
    return String(a.preferred_phone ?? "").replace(/\D/g, "").includes(digits) ? "phone" : null;
  }
  return a.full_name && a.full_name.toLowerCase().includes(t.toLowerCase()) ? "agent" : null;
}
function ym(m: number | null | undefined): string {
  if (m == null) return "N/A";
  const months = Math.round(m);
  const y = Math.floor(months / 12);
  const mo = months % 12;
  if (y && mo) return `${y} yrs ${mo} mos`;
  if (y) return `${y} yrs`;
  return `${mo} mos`;
}
function PctChange({ n }: { n: number | null | undefined }) {
  if (n == null) return <span className="text-neutral-400">N/A</span>;
  return <span className={n >= 0 ? "text-emerald-600" : "text-red-600"}>{`${n >= 0 ? "+" : ""}${n.toLocaleString()}%`}</span>;
}
// A18: "courted" is an internal source name that means nothing to an operator — the data it
// labels IS MLS data, so every per-source row reads "MLS". zillow / realtor / enriched /
// provided keep their own names; the `capitalize` class on the row title-cases those and
// leaves an all-caps "MLS" intact.
const sourceLabel = (s: string) => (s === "courted" ? "MLS" : s);

// Metric cell with a per-source breakdown when the agent is matched across sources AND the
// sources disagree. Identical values collapse to the single number; a source missing the
// metric shows as N/A (matches the Courted-style reference screenshot).
function StatCell({ a, field, fmt }: { a: Agent; field: string; fmt: (v: number | null | undefined) => React.ReactNode }) {
  const stats = a.source_stats ?? [];
  let breakdown: typeof stats = [];
  if (stats.length > 1) {
    const uniq = new Set(stats.map((s) => JSON.stringify(s[field] ?? null)));
    if (uniq.size > 1) breakdown = stats; // values differ (incl. value vs N/A) -> show all
  }
  return (
    <div>
      <div>{fmt(a[field] as number | null | undefined)}</div>
      {breakdown.length > 0 && (
        <div className="mt-0.5 space-y-0.5">
          {breakdown.map((s) => (
            <div key={s.source} className="text-[11px] capitalize text-neutral-400">
              {sourceLabel(s.source)}: {fmt(s[field] as number | null | undefined)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Contact cell with the same per-source breakdown as the numeric StatCell: the preferred
// value on top; when another source carries a DIFFERENT email/phone (normalized — case for
// emails, digits + country code for phones), each source's value is listed underneath.
const normEmailV = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const normPhoneV = (s: string | null | undefined) => {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
};
function ContactCell({ a, field }: { a: Agent; field: "email" | "phone" }) {
  const preferred = (field === "email" ? a.preferred_email : a.preferred_phone) as string | null;
  const ids = (a.source_ids ?? {}) as Record<string, { email?: string | null; phone?: string | null } | undefined>;
  const norm = field === "email" ? normEmailV : normPhoneV;
  const entries: { source: string; value: string | null }[] = (["courted", "zillow", "realtor"] as const)
    .map((s) => ({ source: sourceLabel(s), value: ids[s]?.[field] ?? null }))
    .filter((e) => e.value);
  // enriched + agent-provided emails must stay visible next to the original — Bison
  // leads may carry either, and operators map them back by eye
  if (field === "email" && a.enriched_email) entries.push({ source: "enriched", value: String(a.enriched_email) });
  if (ids.agent_provided?.[field]) entries.push({ source: "provided", value: ids.agent_provided[field] ?? null });
  const uniq = new Set([preferred, ...entries.map((e) => e.value)].filter(Boolean).map((v) => norm(v)));
  const breakdown = uniq.size > 1 ? entries : [];
  return (
    <div>
      <div>{field === "phone" ? phoneFmt(preferred) : na(preferred)}</div>
      {breakdown.length > 0 && (
        <div className="mt-0.5 space-y-0.5">
          {breakdown.map((e) => (
            <div key={e.source} className="text-[11px] capitalize text-neutral-400">
              {e.source}: {e.value}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface Col {
  key: string;
  label: string;
  sortBy?: string;
  // First click on this header sorts this direction (default "desc"). Text columns like MLS /
  // LinkedIn use "asc" so the first click gives A-Z.
  defaultDir?: SortDir;
  align?: "right";
  render: (a: Agent) => React.ReactNode;
}

// Courted default 28-column order.
// mls codes/ids joined — an agent can belong to several MLSs (dedup keeps them all).
// Some belong to 30+, so the cell is width-capped and truncated; hover shows the full list.
const mlsCodes = (a: Agent) => a.mls?.map((m) => m.code).filter(Boolean).join(" | ") || "N/A";
const mlsIds = (a: Agent) => a.mls?.map((m) => m.member_id).filter(Boolean).join(" | ") || "N/A";
const capped = (text: string) => (
  <span className="block max-w-[280px] truncate" title={text}>
    {text}
  </span>
);

const COLUMNS: Col[] = [
  { key: "agent", label: "Agent", sortBy: "full_name", render: (a) => <span className="font-semibold text-neutral-900">{na(a.full_name)}</span> },
  { key: "office", label: "Office", sortBy: "office_name", render: (a) => na(a.office_name) },
  { key: "timeInd", label: "Est. time in industry", sortBy: "est_time_in_industry_months", render: (a) => a.est_time_in_industry_raw ?? "N/A" },
  { key: "license", label: "License number", sortBy: "license_number", render: (a) => na(a.license_number) },
  { key: "title", label: "Title", sortBy: "title", defaultDir: "asc", render: (a) => na(a.title as string | null) },
  { key: "mlsAff", label: "MLS affiliation", sortBy: "mls", defaultDir: "asc", render: (a) => capped(mlsCodes(a)) },
  { key: "mlsId", label: "MLS ID", render: (a) => capped(mlsIds(a)) },
  { key: "homeCity", label: "Home city", sortBy: "home_city", render: (a) => (a.home_city ? `${a.home_city}${a.home_state ? `, ${a.home_state}` : ""}` : "N/A") },
  { key: "homeZip", label: "Home zip", sortBy: "home_zip", render: (a) => na(a.home_zip) },
  { key: "brand", label: "Brand", sortBy: "brand", render: (a) => na(a.brand) },
  { key: "officeCity", label: "Office city", sortBy: "office_city", render: (a) => (a.office_city ? `${a.office_city}${a.office_state ? `, ${a.office_state}` : ""}` : "N/A") },
  { key: "officeZip", label: "Office zip code", sortBy: "office_zip", render: (a) => na(a.office_zip) },
  { key: "timeOffice", label: "Est. time at office", sortBy: "est_time_at_office_months", render: (a) => ym(a.est_time_at_office_months) },
  { key: "avgTimeOffice", label: "Avg. time at office", sortBy: "avg_time_at_office_months", render: (a) => ym(a.avg_time_at_office_months) },
  { key: "transacted", label: "Most transacted city", sortBy: "most_transacted_city", render: (a) => (a.most_transacted_city ? `${a.most_transacted_city}${a.transacted_state ? `, ${a.transacted_state}` : ""}` : "N/A") },
  { key: "vol", label: "Sales volume", sortBy: "sales_volume", align: "right", render: (a) => <StatCell a={a} field="sales_volume" fmt={usd} /> },
  { key: "pct", label: "% Change", sortBy: "pct_change", align: "right", render: (a) => <StatCell a={a} field="pct_change" fmt={(n) => <PctChange n={n} />} /> },
  { key: "buy$", label: "Buy-side ($)", sortBy: "buy_side_dollar", align: "right", render: (a) => <StatCell a={a} field="buy_side_dollar" fmt={usd} /> },
  { key: "list$", label: "List-side ($)", sortBy: "list_side_dollar", align: "right", render: (a) => <StatCell a={a} field="list_side_dollar" fmt={usd} /> },
  { key: "gci", label: "Approx. GCI", sortBy: "approx_gci", align: "right", render: (a) => <StatCell a={a} field="approx_gci" fmt={usd} /> },
  { key: "avgPrice", label: "Avg. sales price", sortBy: "avg_sale_price", align: "right", render: (a) => <StatCell a={a} field="avg_sale_price" fmt={usd} /> },
  { key: "closedTx", label: "Closed transactions", sortBy: "closed_transactions", align: "right", render: (a) => <StatCell a={a} field="closed_transactions" fmt={numv} /> },
  { key: "units", label: "Units", sortBy: "units", align: "right", render: (a) => <StatCell a={a} field="units" fmt={numv} /> },
  { key: "buyN", label: "Buy-side (#)", sortBy: "buy_side_count", align: "right", render: (a) => <StatCell a={a} field="buy_side_count" fmt={numv} /> },
  { key: "listN", label: "List-side (#)", sortBy: "list_side_count", align: "right", render: (a) => <StatCell a={a} field="list_side_count" fmt={numv} /> },
  { key: "rentals", label: "Closed rentals", sortBy: "closed_rentals", align: "right", render: (a) => <StatCell a={a} field="closed_rentals" fmt={numv} /> },
  { key: "avgRent", label: "Avg. rental price", sortBy: "avg_rental_price", align: "right", render: (a) => <StatCell a={a} field="avg_rental_price" fmt={usd} /> },
  { key: "email", label: "Preferred email address", sortBy: "preferred_email", render: (a) => <ContactCell a={a} field="email" /> },
  { key: "phone", label: "Preferred phone number", sortBy: "preferred_phone", render: (a) => <ContactCell a={a} field="phone" /> },
  // Zillow/Realtor-only fields (all-time stats + extras — separate from the LTM metrics)
  { key: "linkedin", label: "LinkedIn", sortBy: "linkedin_url", defaultDir: "asc", render: (a) => {
      if (!a.linkedin_url) return <span className="text-neutral-400">N/A</span>;
      const url = String(a.linkedin_url);
      return <a href={/^https?:\/\//i.test(url) ? url : `https://${url}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">Profile</a>;
    } },
  { key: "languages", label: "Languages", render: (a) => ((a.languages as string[] | null)?.length ? (a.languages as string[]).join(", ") : "N/A") },
  { key: "totalSalesAT", label: "Total sales (all time)", sortBy: "total_sales_all_time", align: "right", render: (a) => numv(a.total_sales_all_time as number | null) },
  { key: "avgPriceAT", label: "Avg. price (all time)", sortBy: "avg_price_all_time", align: "right", render: (a) => usd(a.avg_price_all_time as number | null) },
  { key: "avgVolAT", label: "Avg. sales volume (all time)", sortBy: "avg_sales_volume_all_time", align: "right", render: (a) => usd(a.avg_sales_volume_all_time as number | null) },
  { key: "priceRange", label: "Price range", render: (a) => na(a.price_range as string | null) },
  { key: "otherLic", label: "Other licenses", render: (a) => na(a.other_licenses as string | null) },
  {
    key: "enriched",
    label: "Enriched",
    sortBy: "enriched_at",
    render: (a) =>
      a.enriched_at ? (
        <span className="text-green-700">
          ✓ {String(a.enriched_email_status ?? "enriched")} · {new Date(String(a.enriched_at)).toLocaleDateString()}
        </span>
      ) : (
        <span className="text-neutral-400">—</span>
      ),
  },
  { key: "inCampaign", label: "Client campaign", sortBy: "client_campaigns", defaultDir: "asc", render: (a) => (a.client_campaigns ? capped(String(a.client_campaigns)) : <span className="text-neutral-400">—</span>) },
  // WHERE the reply came from, immediately left of Replied. Until now a replied agent showed a bare
  // tick: no sequencer, no campaign. An agent who only replied in Instantly rendered "✓ replied"
  // beside an em dash in Client campaign, with nothing explaining why. Both tables have carried
  // campaign_name all along; v_agent_reply_sources (0108) is what finally reads it.
  //
  // Sourced from the campaigns the agent REPLIED in, not everything they are a member of, so these
  // are empty exactly when Replied shows an em dash.
  { key: "replySource", label: "Reply source", sortBy: "reply_providers", defaultDir: "asc", render: (a) =>
      a.reply_providers
        ? <span className={String(a.reply_providers).includes(",") ? "font-medium text-violet-700" : "text-neutral-700"}>{String(a.reply_providers)}</span>
        : <span className="text-neutral-400">—</span> },
  { key: "replyCampaign", label: "Reply campaign", sortBy: "reply_campaigns", defaultDir: "asc", render: (a) => (a.reply_campaigns ? capped(String(a.reply_campaigns)) : <span className="text-neutral-400">—</span>) },
  { key: "replied", label: "Replied", sortBy: "has_replied", render: (a) => (a.has_replied ? <span className="text-green-700">✓ replied</span> : <span className="text-neutral-400">—</span>) },
  { key: "bounced", label: "Bounced", sortBy: "has_bounced", render: (a) => (a.has_bounced ? <span className="text-red-600">✗ bounced</span> : <span className="text-neutral-400">—</span>) },
  // How many distinct campaigns hold this agent, across BOTH sequencers since 0109. Nearly half of
  // contacted agents sit in more than one, so the count is worth showing next to the client names
  // rather than inside them.
  { key: "campaignCount", label: "Campaigns", sortBy: "campaign_count", align: "right", render: (a) => (a.campaign_count ? <span className={a.campaign_count > 1 ? "font-medium text-amber-700" : undefined}>{a.campaign_count}</span> : <span className="text-neutral-400">—</span>) },
];

const DEFAULT_COL_ORDER = COLUMNS.map((c) => c.key);

/**
 * Fold a saved column order together with the current default one.
 *
 * The saved order wins for everything it knows about — a user's arrangement is theirs. Columns
 * added since they last saved are placed where the DEFAULT order puts them, right after whichever
 * of their default predecessors the user still has, rather than appended to the end.
 *
 * Appending is what this used to do, and it is wrong for a column whose position is the point:
 * "Reply source" and "Reply campaign" are meant to sit immediately left of Replied, and every
 * existing user has a saved order, so all of them would have found the two new columns marooned
 * past the last money column instead.
 */
function mergeColOrder(saved: string[]): string[] {
  if (!saved.length) return DEFAULT_COL_ORDER;
  const out = saved.filter((k) => DEFAULT_COL_ORDER.includes(k));
  for (const key of DEFAULT_COL_ORDER) {
    if (out.includes(key)) continue;
    const defIdx = DEFAULT_COL_ORDER.indexOf(key);
    // nearest earlier default-order column the user still has; -1 => goes to the front
    let at = 0;
    for (let i = defIdx - 1; i >= 0; i--) {
      const pos = out.indexOf(DEFAULT_COL_ORDER[i]);
      if (pos !== -1) { at = pos + 1; break; }
    }
    out.splice(at, 0, key);
  }
  return out;
}
// Location-mode columns (D4) — the filtered agents grouped by their office location.
const LOC_MODE_COLUMNS: Col[] = [
  { key: "location", label: "Location", sortBy: "location", defaultDir: "asc", render: (r) => <span className="font-semibold text-neutral-900">{na(r.location as string | null)}</span> },
  { key: "locAgents", label: "Agents", sortBy: "agents", align: "right", render: (r) => numv(r.agents as number | null) },
  // Leaders = any agent whose title carries a role (Team Leader, Managing Broker, or both);
  // Salespersons = everyone else. The two always sum to Agents.
  { key: "leaders", label: "TL / MB", sortBy: "leaders", align: "right", render: (r) => numv(r.leaders as number | null) },
  { key: "salespersons", label: "Salespersons", sortBy: "salespersons", align: "right", render: (r) => numv(r.salespersons as number | null) },
  { key: "locOffices", label: "Offices", sortBy: "offices", align: "right", render: (r) => numv(r.offices as number | null) },
  { key: "vol", label: "Sales volume", sortBy: "sales_volume", align: "right", render: (r) => usd(r.sales_volume) },
  { key: "units", label: "Units", sortBy: "units", align: "right", render: (r) => numv(r.units) },
];

// MLS-mode columns (B8) — the filtered agents grouped per MLS membership.
const MLS_MODE_COLUMNS: Col[] = [
  { key: "mlsName", label: "MLS", sortBy: "mls", defaultDir: "asc", render: (r) => <span className="font-semibold text-neutral-900">{na(r.label as string | null)}{r.code && r.label !== r.code ? <span className="font-normal text-neutral-400"> ({String(r.code)})</span> : null}</span> },
  { key: "locAgents", label: "Agents", sortBy: "agents", align: "right", render: (r) => numv(r.agents as number | null) },
  { key: "leaders", label: "TL / MB", sortBy: "leaders", align: "right", render: (r) => numv(r.leaders as number | null) },
  { key: "salespersons", label: "Salespersons", sortBy: "salespersons", align: "right", render: (r) => numv(r.salespersons as number | null) },
  { key: "locOffices", label: "Offices", sortBy: "offices", align: "right", render: (r) => numv(r.offices as number | null) },
  { key: "vol", label: "Sales volume", sortBy: "sales_volume", align: "right", render: (r) => usd(r.sales_volume) },
  { key: "units", label: "Units", sortBy: "units", align: "right", render: (r) => numv(r.units) },
  { key: "updated", label: "Data refreshed", sortBy: "updated", defaultDir: "desc", render: (r) => na(r.updated as string | null) },
];

const COL_BY_KEY: Record<string, Col> = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
const COL_META = COLUMNS.map((c) => ({ key: c.key, label: c.label }));
const LOCKED_COLS = ["agent", "office"];
const COLS_STORAGE = "bs_agent_cols";

// Office-mode columns (offices table + the office's agents).
const OFFICE_COLUMNS: Col[] = [
  { key: "office", label: "Office", sortBy: "office_name", render: (o) => <span className="font-semibold text-neutral-900">{na(o.office_name)}</span> },
  { key: "brand", label: "Brand", sortBy: "brand", defaultDir: "asc", render: (o) => na(o.brand) },
  { key: "officeCity", label: "Office city", sortBy: "office_city", defaultDir: "asc", render: (o) => (o.office_city ? `${o.office_city}${o.office_state ? `, ${o.office_state}` : ""}` : "N/A") },
  { key: "officeZip", label: "Office zip", sortBy: "office_zip", defaultDir: "asc", render: (o) => na(o.office_zip) },
  { key: "vol", label: "Sales volume", sortBy: "sales_volume", align: "right", render: (o) => usd(o.sales_volume) },
  { key: "list$", label: "List-side ($)", sortBy: "list_side_dollar", align: "right", render: (o) => usd(o.list_side_dollar) },
  { key: "buy$", label: "Buy-side ($)", sortBy: "buy_side_dollar", align: "right", render: (o) => usd(o.buy_side_dollar) },
  { key: "units", label: "Units", sortBy: "units", align: "right", render: (o) => numv(o.units) },
  { key: "agentCount", label: "Agents", sortBy: "agent_count", align: "right", render: (o) => numv(o.agent_count) },
  {
    key: "agents",
    label: "Agents at office",
    render: (o) => {
      const names = o.agent_names ?? [];
      if (names.length === 0) return <span className="text-neutral-400">N/A</span>;
      const shown = names.slice(0, 4).join(", ");
      const extra = names.length > 4 ? ` +${names.length - 4}` : "";
      return <span className="text-neutral-600">{shown}{extra}</span>;
    },
  },
];

// Brand-mode columns (B5) — aggregates over the filtered offices, grouped per brand.
const BRAND_COLUMNS: Col[] = [
  { key: "brand", label: "Brand", sortBy: "brand", defaultDir: "asc", render: (b) => <span className="font-semibold text-neutral-900">{na(b.brand)}</span> },
  { key: "officeCount", label: "Offices", sortBy: "office_count", align: "right", render: (b) => numv(b.office_count) },
  { key: "agentCount", label: "Agents", sortBy: "agent_count", align: "right", render: (b) => numv(b.agent_count) },
  { key: "vol", label: "Sales volume", sortBy: "sales_volume", align: "right", render: (b) => usd(b.sales_volume) },
  { key: "units", label: "Units", sortBy: "units", align: "right", render: (b) => numv(b.units) },
];

// Which table columns each ACTIVE filter acts on — those headers get a light-gray tint so it's
// obvious at a glance which columns are being filtered. Keys match COLUMNS / OFFICE_COLUMNS.
function highlightedColumns(f: Filters, mode: SearchMode): Set<string> {
  const s = new Set<string>();
  const active = (r: { buckets: string[]; min: string; max: string }) => r.buckets.length > 0 || !!r.min || !!r.max;
  const ie = (x: { include: string[]; exclude: string[] }) => x.include.length > 0 || x.exclude.length > 0;

  if (f.location.values.length > 0 || f.location.excludeValues.length > 0) {
    const zip = f.location.field === "zip";
    if (mode === "office") {
      s.add(zip ? "officeZip" : "officeCity");
    } else {
      for (const k of f.location.appliesTo) {
        if (k === "office") s.add(zip ? "officeZip" : "officeCity");
        else if (k === "home") s.add(zip ? "homeZip" : "homeCity");
        else if (k === "transacted") s.add("transacted");
      }
    }
  }
  if (active(f.salesVolume)) s.add(f.salesVolume.side === "list" ? "list$" : f.salesVolume.side === "buy" ? "buy$" : "vol");
  if (active(f.closedUnits)) s.add(f.closedUnits.side === "list" ? "listN" : f.closedUnits.side === "buy" ? "buyN" : "units");
  if (active(f.closedTransactions)) s.add(f.closedTransactions.side === "list" ? "listN" : f.closedTransactions.side === "buy" ? "buyN" : "closedTx");
  if (active(f.estTimeInIndustry)) s.add("timeInd");
  if (active(f.approxGci)) s.add("gci");
  if (active(f.avgSalePrice)) s.add("avgPrice");
  if (active(f.estTimeInOffice)) s.add("timeOffice");
  if (active(f.avgTimeAtOffice)) s.add("avgTimeOffice");
  if (mode === "office" && active(f.agentCount)) s.add("agentCount");
  if (ie(f.officeSearch.brand)) s.add("brand");
  if (ie(f.officeSearch.office)) s.add("office");
  if (ie(f.mls)) s.add("mlsAff");
  if (ie(f.license)) s.add("license");
  if (ie(f.name)) s.add("agent");
  if (f.contact.email) s.add("email");
  if (f.contact.phone) s.add("phone");
  const z = f.zillowRealtor;
  if (z.languages.length > 0) s.add("languages");
  if (z.totalSales.min || z.totalSales.max) s.add("totalSalesAT");
  if (z.avgPriceAllTime.min || z.avgPriceAllTime.max) s.add("avgPriceAT");
  if (z.avgVolumeAllTime.min || z.avgVolumeAllTime.max) s.add("avgVolAT");
  if (z.hasLinkedin) s.add("linkedin");
  return s;
}

export function AgentSearch({ initialQuery = "" }: { initialQuery?: string }) {
  const [rows, setRows] = useState<Agent[]>([]);
  const [total, setTotal] = useState(0);
  const [vol, setVol] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState("sales_volume");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [exportOpen, setExportOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [allFiltersOpen, setAllFiltersOpen] = useState(false);
  const [mode, setMode] = useState<SearchMode>("agent");
  const [profileId, setProfileId] = useState<string | null>(null); // A5: agent profile dialog
  const [showAllBrands, setShowAllBrands] = useState(false); // B5: include single-office independents
  const [locGran, setLocGran] = useState<"state" | "county" | "city">("state"); // D4 granularity
  const [locKinds, setLocKinds] = useState<("office" | "home" | "transacted")[]>(["office"]); // D4 basis (multi-select)
  const [source, setSource] = useState<DataSource>("all");
  const [colOrder, setColOrder] = useState<string[]>(DEFAULT_COL_ORDER);
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COLS_STORAGE);
      if (raw) {
        const j = JSON.parse(raw);
        const savedOrder: string[] = Array.isArray(j.order) ? j.order.filter((k: string) => COL_BY_KEY[k]) : [];
        setColOrder(mergeColOrder(savedOrder));
        if (Array.isArray(j.hidden)) setHiddenCols(new Set(j.hidden.filter((k: string) => !LOCKED_COLS.includes(k))));
      }
    } catch {
      /* ignore */
    }
  }, []);

  function applyCols(order: string[], hidden: string[]) {
    const cleanHidden = hidden.filter((k) => !LOCKED_COLS.includes(k));
    setColOrder(order);
    setHiddenCols(new Set(cleanHidden));
    try {
      localStorage.setItem(COLS_STORAGE, JSON.stringify({ order, hidden: cleanHidden }));
    } catch {
      /* ignore */
    }
  }

  const visibleColumns = colOrder.map((k) => COL_BY_KEY[k]).filter((c): c is Col => !!c && !hiddenCols.has(c.key));
  const activeColumns = mode === "office" ? OFFICE_COLUMNS : mode === "brand" ? BRAND_COLUMNS : mode === "location" ? LOC_MODE_COLUMNS : mode === "mls" ? MLS_MODE_COLUMNS : visibleColumns;
  const highlightTerm = (filters.nameQuery ?? "").trim();

  // A15.B: what the option dropdowns narrow themselves against. `enabled` is the shared
  // "Match my filters" switch; each filter's own values are excluded server-side, so picking
  // one city never hides the others. Agent-grained modes only — Office/Brand run on a
  // different engine and keep their full lists.
  const facets = { filters, source, enabled: mode === "agent" || mode === "mls" || mode === "location" };

  // (nameQuery is a find/highlight tool, not a filter, so it does not count here.)
  const filterCount = activeFilterCount(filters, mode);
  // Columns whose filter is active — their headers/cells get a light-gray tint.
  const highlightedCols = highlightedColumns(filters, mode);

  function setF<K extends keyof Filters>(k: K, v: Filters[K]) {
    setFilters((p) => {
      // A7 companion: dismissing a popover now commits its draft, so merely opening and closing
      // one calls this with an unchanged value. Without this guard every stray click outside a
      // filter would fire a fresh /api/search/filter round-trip on 1.1M rows.
      if (JSON.stringify(p[k]) === JSON.stringify(v)) return p;
      return { ...p, [k]: v };
    });
    setPage(1);
  }
  function clearAllFilters() {
    // keep column layout + the top-bar find term; reset every actual filter
    setFilters((p) => ({ ...DEFAULT_FILTERS, nameQuery: p.nameQuery }));
    setPage(1);
  }

  // A13: clicking an office/brand name in Office view jumps to the agent Filter view with
  // that office (or brand) applied as an Include filter — replaces the agent-list pop-up.
  function jumpToAgents(kind: "office" | "brand", name: string) {
    setFilters((f) => ({ ...f, officeSearch: { ...f.officeSearch, [kind]: { include: [name], exclude: [] } } }));
    setMode("agent");
    setPage(1);
    setSelected(new Set());
    setSortBy("sales_volume");
    setSortDir("desc");
  }

  // D4: clicking a location row jumps to the agent grid filtered to that place (office kind —
  // the same basis the tab counts by).
  function jumpToLocation(label: string) {
    setFilters((f) => ({
      ...f,
      location: {
        field: locGran,
        appliesTo: [...locKinds],
        values: [label],
        excludeValues: [],
        excludeField: locGran,
      },
    }));
    setMode("agent");
    setPage(1);
    setSelected(new Set());
    setSortBy("sales_volume");
    setSortDir("desc");
  }

  // B8: clicking an MLS row jumps to the agent grid filtered to that MLS.
  function jumpToMls(mlsId: string) {
    setFilters((f) => ({ ...f, mls: { include: [mlsId], exclude: [] } }));
    setMode("agent");
    setPage(1);
    setSelected(new Set());
    setSortBy("sales_volume");
    setSortDir("desc");
  }

  // Top-bar name search flows through a shared store (not the URL), so it narrows the CURRENT
  // filtered list instead of re-mounting this screen and wiping the applied filters.
  const [nameSearch, setNameSearch] = useNameSearch();
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed the store from a deep-link (/search?q=…) once on mount.
  useEffect(() => {
    if (initialQuery) setNameSearch(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply the search term as the nameQuery filter (debounced), leaving all other filters intact.
  useEffect(() => {
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = setTimeout(() => {
      setFilters((f) => (f.nameQuery === nameSearch ? f : { ...f, nameQuery: nameSearch }));
      setPage(1);
    }, 300);
    return () => {
      if (nameTimer.current) clearTimeout(nameTimer.current);
    };
  }, [nameSearch]);

  // Latest-wins: a slow "All" request can resolve after a fast "Zillow/Realtor" one and
  // overwrite it. Each fetch bumps a token and aborts the previous request; only the newest
  // response is allowed to update the table.
  const reqSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);
  const jumpTopRef = useRef(false); // pagination should land at the top of the new page

  // A FAILED REQUEST MUST NEVER BE RENDERED AS A RESULT.
  //
  // This used to read the body without checking res.ok. An error response is {error: "..."}
  // with no data/totalCount, so "json.data ?? []" and "json.totalCount ?? 0" turned any failure
  // -- a timeout, a 500, a dropped connection -- into a confident "0 Agents found · $0 Sales
  // volume", indistinguishable from a genuinely empty result. On a live sales tool that is
  // worse than a spinner: it reports "no agents" to a client when agents exist.
  //
  // Now a failure changes nothing on screen. The table keeps the rows it already has, we retry
  // once quietly, and if that also fails we stop and leave the previous results in place. No
  // error text is ever shown -- deliberately, this is client-facing -- but no wrong number is
  // shown either. Only setLoading moves.
  //
  // There is also a timeout: the fetch previously had an abort signal but nothing to fire it,
  // so a stalled request left the spinner running forever with no way out.
  const fetchData = useCallback(async () => {
    const seq = ++reqSeq.current;
    abortRef.current?.abort();
    scrollTopRef.current = scrollRef.current?.scrollTop ?? 0; // remember scroll for restore
    setLoading(true);

    const payload = JSON.stringify({
      mode,
      source,
      sortBy,
      sortDir,
      page,
      pageSize,
      // B5: single-office "brands" are just the brokerage's own name — hidden by default
      filters:
        mode === "brand" && showAllBrands ? { ...filters, includeSingleOfficeBrands: "true" }
        : mode === "location" ? { ...filters, locGranularity: locGran, locKinds }
        : filters,
    });

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        // a fresh controller per attempt: the previous one may already be aborted by the timer
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        try {
          const res = await fetch("/api/search/filter", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            signal: ctrl.signal,
          });
          if (seq !== reqSeq.current) return; // a newer request superseded this one
          if (!res.ok) continue;              // retry once, then give up keeping current rows
          const json: SearchResponse = await res.json();
          if (seq !== reqSeq.current) return;
          if (!Array.isArray(json?.data)) continue; // malformed/error body — never render it
          setRows(json.data);
          setTotal(json.totalCount ?? 0);
          setVol(json.salesVolumeTotal ?? 0);
          return;
        } catch {
          // superseded requests abort by design; anything else falls through to the retry
          if (seq !== reqSeq.current) return;
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [mode, source, sortBy, sortDir, page, pageSize, filters, showAllBrands, locGran, locKinds]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Keep the table scroll position across filter/sort changes (don't jump to the top); but a
  // page change should land at the top of the new page.
  useLayoutEffect(() => {
    if (loading || !scrollRef.current) return;
    if (jumpTopRef.current) {
      scrollRef.current.scrollTop = 0;
      jumpTopRef.current = false;
    } else {
      scrollRef.current.scrollTop = scrollTopRef.current;
    }
  }, [rows, loading]);

  function toggleSort(col: Col) {
    if (!col.sortBy) return;
    if (sortBy === col.sortBy) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col.sortBy);
      setSortDir(col.defaultDir ?? "desc");
    }
    setPage(1);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.add(r.id));
      return next;
    });
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Title + filters */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex shrink-0 items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">
            {mode === "office" ? "Office Search" : mode === "brand" ? "Brand Search" : mode === "location" ? "Location Search" : mode === "mls" ? "MLS Search" : "Agent Search"}
          </h1>
          <div className="inline-flex rounded-lg border border-neutral-300 bg-white p-0.5 text-sm">
            {(["agent", "office", "brand", "location", "mls"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  if (m === mode) return; // misclick on the active button must not wipe state
                  // Agent Count means an office headcount in Office/Brand and a place's or MLS's
                  // total in Location/MLS, and the two use disjoint bucket sets. Carrying a bucket
                  // across that boundary would leave it APPLIED but unselectable in the control —
                  // a filter you can feel and cannot see. Min/max carry over fine; only the
                  // buckets are dropped, and only when crossing between the two groups.
                  const placeGrain = (x: string) => x === "location" || x === "mls";
                  if (placeGrain(m) !== placeGrain(mode) && filters.agentCount.buckets.length) {
                    setFilters((f) => ({ ...f, agentCount: { ...f.agentCount, buckets: [] } }));
                  }
                  setMode(m);
                  setPage(1);
                  setSelected(new Set());
                  // modes sort on different columns — reset to the default
                  setSortBy("sales_volume");
                  setSortDir("desc");
                }}
                className={`rounded-md px-3 py-1 font-medium transition-colors ${mode === m ? "bg-brand text-white" : "text-neutral-600 hover:text-neutral-900"}`}
              >
                {m === "agent" ? "Agent" : m === "office" ? "Office" : m === "brand" ? "Brand" : m === "location" ? "Location" : "MLS"}
              </button>
            ))}
          </div>
          <div className="inline-flex rounded-lg border border-neutral-300 bg-white p-0.5 text-sm">
            {([["all", "All"], ["courted", "MLS"], ["zillow_realtor", "Zillow / Realtor"]] as const).map(([s, lbl]) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  if (s === source) return; // misclick on the active button must not wipe state
                  setSource(s);
                  setPage(1);
                  setSelected(new Set());
                }}
                className={`rounded-md px-3 py-1 font-medium transition-colors ${source === s ? "bg-brand text-white" : "text-neutral-600 hover:text-neutral-900"}`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {filters.nameQuery && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-green-200/70 px-2.5 py-1.5 text-sm font-medium text-green-900">
              Find: “{filters.nameQuery}”
              <button type="button" onClick={() => setNameSearch("")} className="text-green-700 hover:text-green-900" aria-label="Clear name search">
                ×
              </button>
            </span>
          )}
          {/* Only the filters the current mode's query actually applies are shown — office
              mode narrows on location / volume / office / units / agent count / client. */}
          <ClientPopover value={filters.orchClientIds} clientMode={filters.orchClientMode} onChange={(ids, m) => { setFilters((p) => ({ ...p, orchClientIds: ids, orchClientMode: m })); setPage(1); }} />
          {/* Office/Brand views filter OFFICES (office locations only); Agent, MLS and
              Location views filter AGENTS — all three location kinds apply (B8 follow-up). */}
          <LocationPopover value={filters.location} onChange={(v) => setF("location", v)} officeMode={mode === "office" || mode === "brand"} mlsIds={filters.mls.include} facets={facets} />
          <RangePopover label="Sales volume" hasSide prefix="$" buckets={SALES_VOLUME_BUCKETS} value={filters.salesVolume} onChange={(v) => setF("salesVolume", v)} />
          <OfficeSearchPopover value={filters.officeSearch} onChange={(v) => setF("officeSearch", v)} facets={facets} />
          {mode === "agent" && (
            <>
              <MlsPopover
                value={filters.mls}
                multiMls={filters.multiMls}
                mlsCount={filters.mlsCount}
                facets={facets}
                onChange={(v, multi, mc) => {
                  setFilters((f) => ({ ...f, mls: v, multiMls: multi, mlsCount: mc }));
                  setPage(1);
                }}
              />
              <TitlePopover value={filters.title} onChange={(v) => setF("title", v)} />
              <LicensePopover value={filters.license} onChange={(v) => setF("license", v)} />
              <NamePopover value={filters.name} onChange={(v) => setF("name", v)} />
              <ContactPopover value={filters.contact} onChange={(v) => setF("contact", v)} />
            </>
          )}
          {/* A21: saved views now apply in every mode. Agent / MLS / Location resolve them via
              fn_agent_where; Office / Brand via fn_office_where (0082), where a view means
              "the offices those agents work at". */}
          <SavedViewsPopover value={filters.savedViews} onChange={(v) => setF("savedViews", v)} />
          {(mode === "office" || mode === "brand") && (
            <>
              <MlsPopover
                value={filters.mls}
                multiMls={filters.multiMls}
                mlsCount={filters.mlsCount}
                officeMode
                onChange={(v, multi, mc) => {
                  setFilters((f) => ({ ...f, mls: v, multiMls: multi, mlsCount: mc }));
                  setPage(1);
                }}
              />
              {/* A19: named "Agent Count" in both Office and Brand views, ranging on
                  offices.agent_count. In Office view that is the office's own headcount; in Brand
                  view 0088 moved it AFTER the grouping, so it selects brands by their brand-wide
                  total (NextHome's 2,588 agents across 415 offices used to be hidden because no
                  single office reached 100). */}
              <RangePopover label="Agent Count" suffix="#" buckets={COUNT_BUCKETS} value={{ side: "all", ...filters.agentCount }} onChange={(v) => setF("agentCount", { buckets: v.buckets, min: v.min, max: v.max })} />
            </>
          )}
          {/* 0114: the same control for Location and MLS, where it ranges on the place's or the
              MLS's own agent total — "cities with 100+ agents" is 2,571 of 18,266. Different
              buckets because these are orders of magnitude larger than an office (see
              PLACE_COUNT_BUCKETS). Unlike every other filter in these two views this one is NOT an
              agent predicate, so it filters the cached rollup directly rather than forcing the
              4-second live aggregate. */}
          {(mode === "location" || mode === "mls") && (
            <RangePopover label="Agent Count" suffix="#" buckets={PLACE_COUNT_BUCKETS} value={{ side: "all", ...filters.agentCount }} onChange={(v) => setF("agentCount", { buckets: v.buckets, min: v.min, max: v.max })} />
          )}
          {/* office mode always ranges on total units — the List/Buy split is agent-only */}
          <RangePopover label="Closed units" hasSide={mode === "agent"} prefix="#" buckets={COUNT_BUCKETS} value={filters.closedUnits} onChange={(v) => setF("closedUnits", v)} />
          {/* A17: Closed transactions, Est. time in industry and Approx. GCI live in the
              All-filters drawer only — the top bar was too crowded to scan. They are still
              fully applied filters; the "All filters" badge counts them either way. */}
          {mode === "agent" && (
            <ZillowRealtorPopover value={filters.zillowRealtor ?? DEFAULT_FILTERS.zillowRealtor} onChange={(v) => setF("zillowRealtor", v)} />
          )}
          {mode === "agent" && (
            <button
              type="button"
              onClick={() => setAllFiltersOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 bg-white px-3.5 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              <SlidersHorizontal className="h-4 w-4" />
              All filters
              {filterCount > 0 && (
                <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-neutral-900 px-1.5 text-xs font-medium text-white">
                  {filterCount}
                </span>
              )}
            </button>
          )}
          {filterCount > 0 && (
            <button type="button" onClick={clearAllFilters} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-sm font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800">
              <X className="h-4 w-4" />
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* White card */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        {/* Count + actions */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <p className="text-sm">
            {loading ? (
              <span className="text-neutral-500">Loading…</span>
            ) : (
              <>
                <span className="font-semibold text-neutral-900">{total.toLocaleString()}</span>
                <span className="text-neutral-500">{mode === "office" ? " Offices found" : mode === "brand" ? " Brands found" : mode === "location" ? " Locations found" : mode === "mls" ? " MLSs found" : " Agents found"}</span>
                <span className="px-2 text-neutral-300">•</span>
                <span className="font-semibold text-neutral-900">{usdShort(vol)}</span>
                <span className="text-neutral-500"> Sales volume</span>
                {mode === "agent" && rows[0]?.mls_scoped === true && (
                  <span className="ml-3 rounded-md bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700" title="Production columns show only the selected MLS's numbers (A5)">
                    Numbers scoped to selected MLS
                  </span>
                )}
                {mode === "location" && (
                  <span className="ml-4 inline-flex items-center gap-1.5">
                    {(["state", "county", "city"] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => { setLocGran(g); setPage(1); }}
                        className={locGran === g
                          ? "rounded-full border border-brand bg-brand px-2.5 py-0.5 text-xs text-white"
                          : "rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs text-neutral-700 hover:border-neutral-400"}
                      >
                        {g === "state" ? "State" : g === "county" ? "County" : "City"}
                      </button>
                    ))}
                    <span className="mx-1 text-neutral-300">|</span>
                    {(["office", "home", "transacted"] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        title={`Count agents by ${k} location — combine freely; an agent counts once per place`}
                        onClick={() => {
                          setLocKinds((ks) => {
                            if (ks.includes(k)) return ks.length > 1 ? ks.filter((x) => x !== k) : ks; // never empty
                            return [...ks, k];
                          });
                          setPage(1);
                        }}
                        className={locKinds.includes(k)
                          ? "rounded-full border border-brand bg-brand px-2.5 py-0.5 text-xs text-white"
                          : "rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs text-neutral-700 hover:border-neutral-400"}
                      >
                        {k === "office" ? "Office" : k === "home" ? "Home" : "Transacted"}
                      </button>
                    ))}
                  </span>
                )}
                {mode === "brand" && (
                  <label className="ml-4 inline-flex items-center gap-1.5 text-xs text-neutral-600">
                    <Checkbox
                      checked={showAllBrands}
                      onCheckedChange={() => {
                        setShowAllBrands((v) => !v);
                        setPage(1);
                      }}
                      aria-label="Include single-office brands"
                    />
                    Include single-office brands
                  </label>
                )}
              </>
            )}
          </p>
          <div className="flex items-center gap-1">
            {(mode === "agent" || mode === "office") && (
              <button type="button" title="Edit columns" onClick={() => setEditOpen(true)} className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100">
                <SlidersHorizontal className="h-[18px] w-[18px]" />
              </button>
            )}
            {(mode === "agent" || mode === "office") && (
              <button type="button" title="Export — Send to campaign / CSV" onClick={() => setExportOpen(true)} className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100">
                <Download className="h-[18px] w-[18px]" />
              </button>
            )}
            {(mode === "agent" || mode === "office") && (
              <SavedViews
                filters={filters}
                selected={filters.savedViews.include}
                onSelect={(ids) => setF("savedViews", { ...filters.savedViews, include: ids })}
                onLoad={(f) => {
                  setFilters(normalizeFilters(f)); // fills newer keys + folds legacy orchClientId -> orchClientIds
                  setNameSearch(f.nameQuery ?? ""); // keep the top-bar search box in sync with the loaded view
                  setPage(1);
                }}
              />
            )}
          </div>
        </div>

        {/* Table */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto border-t border-neutral-200">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-white">
              <tr className="border-b border-neutral-200">
                <th className="w-10 px-4 py-2.5 text-left">
                  {(mode === "agent" || mode === "office") && <Checkbox checked={allChecked} onCheckedChange={toggleAll} aria-label="Select all" />}
                </th>
                {activeColumns.map((col) => {
                  const active = sortBy === col.sortBy;
                  return (
                    <th
                      key={col.key}
                      className={`whitespace-nowrap px-4 py-2.5 text-[13px] font-medium text-neutral-500 ${col.align === "right" ? "text-right" : "text-left"} ${highlightedCols.has(col.key) ? "bg-neutral-100" : ""}`}
                    >
                      {col.sortBy ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col)}
                          className={`inline-flex items-center gap-1 ${col.align === "right" ? "flex-row-reverse" : ""} ${active ? "text-neutral-900" : "hover:text-neutral-700"}`}
                        >
                          {col.label}
                          {active ? (
                            sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUpDown className="h-3 w-3 text-neutral-300" />
                          )}
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={activeColumns.length + 1} className="py-16 text-center text-sm text-neutral-400">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={activeColumns.length + 1} className="py-16 text-center text-sm text-neutral-400">
                    {mode === "office" ? "No offices found." : mode === "brand" ? "No brands found." : mode === "location" ? "No locations found." : mode === "mls" ? "No MLSs found." : "No agents found."}
                  </td>
                </tr>
              ) : (
                rows.map((a) => {
                  const hitCol = mode === "agent" ? searchHit(a, highlightTerm) : null;
                  return (
                    <tr
                      key={a.id ?? String(a.brand ?? a.location ?? a.mls_id)}
                      className="border-b border-neutral-100 hover:bg-neutral-50"
                    >
                      <td className="w-10 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        {(mode === "agent" || mode === "office") && (
                          <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleOne(a.id)} aria-label="Select row" />
                        )}
                      </td>
                      {activeColumns.map((col) => {
                        // green highlight on the cell that matched (name, email, or phone); the
                        // Agent cell always lights too so the row is obvious when that column is hidden
                        const cellHit = !!hitCol && (col.key === hitCol || col.key === "agent");
                        // A13/B5: office & brand cells jump to the agent grid with that value
                        // applied as an Include filter; the agent name opens the profile (A5).
                        // B-hyperlink: the same applies in the AGENT grid — clicking an office or
                        // brand cell applies it as the Office Search filter right there.
                        const jumpKind =
                          (mode === "office" || mode === "agent") && col.key === "office" ? "office"
                          : (mode === "office" || mode === "brand" || mode === "agent") && col.key === "brand" ? "brand"
                          : null;
                        const jumpValue = jumpKind === "office" ? a.office_name : jumpKind === "brand" ? a.brand : null;
                        const isProfile = mode === "agent" && col.key === "agent" && !!a.id;
                        const isLocJump = mode === "location" && col.key === "location" && !!a.location;
                        const isMlsJump = mode === "mls" && col.key === "mlsName" && !!a.mls_id;
                        const onClick =
                          jumpKind && jumpValue ? () => jumpToAgents(jumpKind, String(jumpValue))
                          : isLocJump ? () => jumpToLocation(String(a.location))
                          : isMlsJump ? () => jumpToMls(String(a.mls_id))
                          : isProfile ? () => setProfileId(a.id)
                          : undefined;
                        return (
                          <td
                            key={col.key}
                            onClick={onClick}
                            title={jumpKind && jumpValue ? `Show agents in this ${jumpKind}` : isProfile ? "Open profile" : undefined}
                            className={`whitespace-nowrap px-4 py-3 text-neutral-700 ${col.align === "right" ? "text-right tabular-nums" : "text-left"} ${cellHit ? "bg-green-200/70" : highlightedCols.has(col.key) ? "bg-neutral-50" : ""} ${onClick ? "cursor-pointer hover:underline" : ""}`}
                          >
                            {col.render(a)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-neutral-200 px-4 py-3 text-sm">
          <div className="flex items-center gap-3 text-neutral-500">
            <span>Items per page</span>
            {PAGE_SIZES.map((s) => (
              <button
                key={s}
                onClick={() => {
                  if (s === pageSize && page === 1) return; // no-op click must not strand the jump flag
                  jumpTopRef.current = true;
                  setPageSize(s);
                  setPage(1);
                }}
                className={s === pageSize ? "font-semibold text-neutral-900 underline underline-offset-4" : "text-neutral-500 hover:text-neutral-800"}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-neutral-600">
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => { jumpTopRef.current = true; setPage((p) => p - 1); }}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="flex h-8 min-w-8 items-center justify-center rounded-md border border-neutral-200 px-2">{page}</span>
            <span className="text-neutral-500">out of {totalPages.toLocaleString()}</span>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-200 disabled:opacity-40"
              disabled={page >= totalPages}
              onClick={() => { jumpTopRef.current = true; setPage((p) => p + 1); }}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <AgentProfileDialog agentId={profileId} onClose={() => setProfileId(null)} />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} filters={filters} total={total} selectedIds={Array.from(selected)} source={source} mode={mode} />
      <EditColumnsModal
        open={editOpen}
        onOpenChange={setEditOpen}
        columns={COL_META}
        locked={LOCKED_COLS}
        order={colOrder}
        hidden={[...hiddenCols]}
        defaultOrder={DEFAULT_COL_ORDER}
        onSave={applyCols}
      />
      <AllFiltersDrawer
        open={allFiltersOpen}
        onOpenChange={setAllFiltersOpen}
        filters={filters}
        onApply={(f) => {
          setFilters(f);
          setNameSearch(f.nameQuery ?? ""); // keep the top-bar search box in sync after applying the drawer
          setPage(1);
        }}
      />
    </div>
  );
}
