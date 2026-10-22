// Filter state for the Agent Search screen. Maps 1:1 to fn_filter_search's p_filters.

export type LocationField = "city" | "zip" | "county" | "state";
export type LocationKind = "office" | "home" | "transacted";
export type VolumeSide = "all" | "list" | "buy";

export interface IncludeExclude {
  include: string[];
  exclude: string[];
}
// A location pick: a plain string uses the filter's current field; a tagged entry
// carries its OWN geography level, so one filter can mix city + county + zip + state.
export type LocEntry = string | { f: LocationField; v: string };
export const locV = (x: LocEntry): string => (typeof x === "string" ? x : x.v);
export const locF = (x: LocEntry, fallback: LocationField): LocationField => (typeof x === "string" ? fallback : x.f);

export interface LocationFilter {
  field: LocationField;
  appliesTo: LocationKind[];
  values: LocEntry[];        // include (mixed levels allowed)
  excludeValues: LocEntry[]; // exclude (A14/D3) — agents matching any of these are hidden
  excludeField?: LocationField; // D3: default level for plain-string excludes
}
export interface RangeSide {
  side: VolumeSide;
  buckets: string[];
  min: string;
  max: string;
}
export interface RangeF {
  buckets: string[];
  min: string;
  max: string;
}
export interface OfficeSearchFilter {
  brand: IncludeExclude;
  office: IncludeExclude;
}
export interface MinMax {
  min: string;
  max: string;
}
// Grouped filter over the Zillow/Realtor-only fields (one chip, everything inside).
export interface ZillowRealtorFilter {
  languages: string[];
  totalSales: MinMax; // all-time
  avgPriceAllTime: MinMax;
  avgVolumeAllTime: MinMax;
  hasLinkedin: boolean;
}

export interface Filters {
  location: LocationFilter;
  salesVolume: RangeSide;
  closedUnits: RangeSide;
  closedTransactions: RangeSide;
  estTimeInIndustry: RangeF;
  approxGci: RangeF;
  avgSalePrice: RangeF;
  estTimeInOffice: RangeF;
  avgTimeAtOffice: RangeF;
  officeSearch: OfficeSearchFilter;
  mls: IncludeExclude; // mls ids
  title: IncludeExclude;
  license: IncludeExclude; // license numbers
  name: IncludeExclude; // full names (include/exclude)
  nameQuery: string; // free-text name search (top search bar)
  orchClientIds: string[]; // orchestrator clients (orch_clients.id) — [] = off; multi-select
  orchClientMode: "include" | "exclude"; // include those clients' leads, or exclude them
  contact: { email: "" | "has" | "missing"; phone: "" | "has" | "missing"; enriched: "" | "has" | "missing"; inCampaign: "" | "has" | "missing"; replied: "" | "has" | "missing"; bounced: "" | "has" | "missing" }; // has/missing per dimension ("" = any); enriched=C2, inCampaign=C5, replied=C4
  multiMls: boolean; // only agents affiliated with 2+ MLSs
  multiCampaign: boolean; // only agents present in 2+ Bison campaigns
  mlsCount: { buckets: string[] }; // exact MLS-affiliation counts: "2".."5" exact, "6+" open (B3)
  savedViews: { include: string[]; exclude: string[] }; // saved_lists ids used as live include/exclude sets (A12)
  // Rollup-level count — means a different thing per view: the office's headcount (Office),
  // the brand total (Brand), the place / MLS total (Location, MLS). Never read by fn_agent_where.
  agentCount: RangeF;
  // 0126: Agent view only — agents whose OFFICE has this many agents (offices.agent_count).
  // Its own key because agentCount's meaning changes per view. Sent from the Agent view only;
  // agent-search strips it everywhere else (queryFilters).
  officeAgentCount: RangeF;
  zillowRealtor: ZillowRealtorFilter;
}

export const DEFAULT_FILTERS: Filters = {
  location: { field: "city", appliesTo: ["office", "home", "transacted"], values: [], excludeValues: [], excludeField: "city" },
  salesVolume: { side: "all", buckets: [], min: "", max: "" },
  closedUnits: { side: "all", buckets: [], min: "", max: "" },
  closedTransactions: { side: "all", buckets: [], min: "", max: "" },
  estTimeInIndustry: { buckets: [], min: "", max: "" },
  approxGci: { buckets: [], min: "", max: "" },
  avgSalePrice: { buckets: [], min: "", max: "" },
  estTimeInOffice: { buckets: [], min: "", max: "" },
  avgTimeAtOffice: { buckets: [], min: "", max: "" },
  officeSearch: { brand: { include: [], exclude: [] }, office: { include: [], exclude: [] } },
  mls: { include: [], exclude: [] },
  title: { include: [], exclude: [] },
  license: { include: [], exclude: [] },
  name: { include: [], exclude: [] },
  nameQuery: "",
  orchClientIds: [],
  orchClientMode: "include",
  contact: { email: "", phone: "", enriched: "", inCampaign: "", replied: "", bounced: "" },
  multiMls: false,
  multiCampaign: false,
  mlsCount: { buckets: [] },
  savedViews: { include: [], exclude: [] },
  agentCount: { buckets: [], min: "", max: "" },
  officeAgentCount: { buckets: [], min: "", max: "" },
  zillowRealtor: { languages: [], totalSales: { min: "", max: "" }, avgPriceAllTime: { min: "", max: "" }, avgVolumeAllTime: { min: "", max: "" }, hasLinkedin: false },
};

// Bucket sets: { key } is sent to the RPC (must match fn_bucket_cond); { label } is displayed.
export interface Bucket {
  key: string;
  label: string;
}
export const SALES_VOLUME_BUCKETS: Bucket[] = [
  { key: "$0-5M", label: "$0 - $5M" },
  { key: "$5-10M", label: "$5M - $10M" },
  { key: "$10-20M", label: "$10M - $20M" },
  { key: "$20-50M", label: "$20M - $50M" },
  { key: "$50-100M", label: "$50M - $100M" },
  { key: "$100M+", label: "$100M+" },
];
export const COUNT_BUCKETS: Bucket[] = [
  { key: "1-5", label: "1 - 5" },
  { key: "5-10", label: "5 - 10" },
  { key: "10-20", label: "10 - 20" },
  { key: "20+", label: "20+" },
];

// Agent Count in the Location and MLS views. COUNT_BUCKETS above is sized for a single office's
// headcount and is meaningless at this grain: every one of the 54 MLSs holds 562+ agents, so all
// of them would land in "20+". Observed medians span four orders of magnitude -- city 3, county 7,
// state 834, MLS 14,555 -- hence a log-ish scale. Must stay in step with fn_bucket_cond (0114).
export const PLACE_COUNT_BUCKETS: Bucket[] = [
  { key: "1-10", label: "1 - 10" },
  { key: "10-100", label: "10 - 100" },
  { key: "100-1K", label: "100 - 1K" },
  { key: "1K-10K", label: "1K - 10K" },
  { key: "10K+", label: "10K+" },
];
export const YEAR_BUCKETS: Bucket[] = [
  { key: "0-1yr", label: "0 - 1 yr" },
  { key: "1-3yrs", label: "1 - 3 yrs" },
  { key: "3-5yrs", label: "3 - 5 yrs" },
  { key: "5-10yrs", label: "5 - 10 yrs" },
  { key: "10+yrs", label: "10+ yrs" },
];
export const GCI_BUCKETS: Bucket[] = [
  { key: "$0-100K", label: "$0 - $100K" },
  { key: "$100-250K", label: "$100K - $250K" },
  { key: "$250-500K", label: "$250K - $500K" },
  { key: "$500K-1M", label: "$500K - $1M" },
  { key: "$1M+", label: "$1M+" },
];
export const TITLES = ["Salesperson", "Team Leader", "Managing Broker"];

// active-count helpers
export const ieCount = (ie: IncludeExclude) => ie.include.length + ie.exclude.length;
export const rangeCount = (r: { buckets: string[]; min: string; max: string }) =>
  r.buckets.length + (r.min ? 1 : 0) + (r.max ? 1 : 0);
export const officeSearchCount = (o: OfficeSearchFilter) => ieCount(o.brand) + ieCount(o.office);
const mmCount = (m: MinMax) => (m.min ? 1 : 0) + (m.max ? 1 : 0);
export const zillowRealtorCount = (z: ZillowRealtorFilter) =>
  z.languages.length + mmCount(z.totalSales) + mmCount(z.avgPriceAllTime) + mmCount(z.avgVolumeAllTime) + (z.hasLinkedin ? 1 : 0);
export const contactCount = (c: { email: string; phone: string; enriched?: string; inCampaign?: string; replied?: string; bounced?: string }) =>
  (c.email ? 1 : 0) + (c.phone ? 1 : 0) + (c.enriched ? 1 : 0) + (c.inCampaign ? 1 : 0) + (c.replied ? 1 : 0) + (c.bounced ? 1 : 0);

// Merge a partial/legacy filters object onto the defaults. Older saved views stored a single
// `orchClientId` (string) before the Client filter became multi-select — fold it into the
// `orchClientIds` array so those views still apply their client. Newer keys fall back to defaults.
export function normalizeFilters(
  f: Partial<Filters> & { orchClientId?: string; missingContact?: { email: boolean; phone: boolean } }
): Filters {
  const merged: Filters = { ...DEFAULT_FILTERS, ...(f as Filters) };
  if ((!merged.orchClientIds || merged.orchClientIds.length === 0) && typeof f.orchClientId === "string" && f.orchClientId) {
    merged.orchClientIds = [f.orchClientId];
  }
  // legacy missingContact (pre-contact saved views) folds into the has/missing model
  if (f.missingContact && (!f.contact || (!f.contact.email && !f.contact.phone))) {
    merged.contact = {
      email: f.missingContact.email ? "missing" : "",
      phone: f.missingContact.phone ? "missing" : "",
      enriched: "",
      inCampaign: "",
      replied: "",
      bounced: "",
    };
  }
  if (!merged.contact) merged.contact = { email: "", phone: "", enriched: "", inCampaign: "", replied: "", bounced: "" };
  merged.contact = { email: merged.contact.email ?? "", phone: merged.contact.phone ?? "", enriched: merged.contact.enriched ?? "", inCampaign: merged.contact.inCampaign ?? "", replied: merged.contact.replied ?? "", bounced: merged.contact.bounced ?? "" };
  if (!merged.savedViews) merged.savedViews = { include: [], exclude: [] };
  else merged.savedViews = { include: merged.savedViews.include ?? [], exclude: merged.savedViews.exclude ?? [] };
  if (!merged.location.excludeValues) merged.location = { ...merged.location, excludeValues: [] };
  const okEntry = (x: unknown) => typeof x === "string" || (!!x && typeof (x as { v?: unknown }).v === "string" && typeof (x as { f?: unknown }).f === "string");
  merged.location = { ...merged.location, values: (merged.location.values ?? []).filter(okEntry), excludeValues: (merged.location.excludeValues ?? []).filter(okEntry) };
  if (!merged.location.excludeField) merged.location = { ...merged.location, excludeField: merged.location.field };
  if (!merged.mlsCount || !Array.isArray(merged.mlsCount.buckets)) merged.mlsCount = { buckets: [] };
  if (!merged.officeAgentCount || !Array.isArray(merged.officeAgentCount.buckets))
    merged.officeAgentCount = { buckets: [], min: "", max: "" };
  // saved views stored before the multi-campaign filter existed carry no such key
  merged.multiCampaign = merged.multiCampaign === true;
  delete (merged as Partial<Filters> & { orchClientId?: string }).orchClientId;
  delete (merged as Partial<Filters> & { missingContact?: unknown }).missingContact;
  return merged;
}

// Total count of every ACTIVE agent-search filter — drives the "All filters (N)" badge and
// the Clear-all button visibility. (nameQuery is a find/highlight tool, not counted.)
// Mode-aware: the badge counts ONLY the filters the current mode's query actually applies.
// Office mode applies just: location, sales volume, office search, closed units, agent count,
// and the client filter — everything else is agent-only.
export function activeFilterCount(f: Filters, mode: "agent" | "office" | "brand" | "location" | "mls" = "agent"): number {
  const shared =
    f.location.values.length + f.location.excludeValues.length +
    rangeCount(f.salesVolume) +
    officeSearchCount(f.officeSearch) +
    rangeCount(f.closedUnits) +
    (f.orchClientIds.length ? 1 : 0);
  // Location + MLS are agent-grained (fn_agent_where), so saved views narrow them too (A21).
  // They also carry Agent Count (0114), which unlike every other filter here ranges on the OUTPUT
  // row's agent total rather than on an agent column.
  if (mode === "location" || mode === "mls")
    return shared + rangeCount(f.agentCount) + f.savedViews.include.length + f.savedViews.exclude.length;
  // office + brand views also carry the MLS filter (office_mls), the per-office agent count,
  // and saved views (A21b — resolved at office grain by fn_office_where)
  if (mode === "brand" || mode === "office")
    return shared + f.mls.include.length + f.mls.exclude.length + rangeCount(f.agentCount)
      + f.savedViews.include.length + f.savedViews.exclude.length;
  return (
    shared +
    f.mls.include.length + f.mls.exclude.length + (f.multiMls ? 1 : 0) + f.mlsCount.buckets.length +
    (f.multiCampaign ? 1 : 0) +
    f.savedViews.include.length + f.savedViews.exclude.length +
    ieCount(f.title) +
    ieCount(f.license) +
    rangeCount(f.closedTransactions) +
    rangeCount(f.estTimeInIndustry) +
    rangeCount(f.approxGci) +
    rangeCount(f.avgSalePrice) +
    rangeCount(f.estTimeInOffice) +
    rangeCount(f.avgTimeAtOffice) +
    rangeCount(f.officeAgentCount) +
    ieCount(f.name) +
    contactCount(f.contact) +
    zillowRealtorCount(f.zillowRealtor)
  );
}
