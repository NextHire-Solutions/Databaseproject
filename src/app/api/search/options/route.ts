import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api/require-permission";
import { sanitizeSavedViews } from "@/lib/filters/sanitize-saved-views";
import { allowedClientIds, restrictClientFilter } from "@/lib/auth/client-access";

// Typeahead options for the Location / Office Search / MLS filters.
// Location options come back as objects {v, n, var} with live totals (precomputed
// location_options table — instant, agent-count ordered); other types stay string arrays.
// scope=office limits location options to office locations (A8 — the Office view).
//
// A15: `mls` is a comma-separated list of selected MLS ids. When present, location options are
// scoped to those MLSs — only places their agents are actually in, counted within them. Ignored
// for non-location types and for office scope (the per-MLS table is agent-grained).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const gate = await requirePermission("search");
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") ?? "";
  const field = searchParams.get("field");
  const q = searchParams.get("q") ?? "";
  const scope = searchParams.get("scope") === "office" ? "office" : "agent";
  // validated here so a malformed id can never reach the SECURITY DEFINER RPC as a uuid[] cast
  const mls = (searchParams.get("mls") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID.test(s));

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_search_options", {
    p_type: type,
    p_field: field,
    p_q: q,
    p_scope: scope,
    p_mls: mls.length ? mls : null,
  });
  if (error) {
    console.error("options RPC error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (type === "location" && data && !Array.isArray(data)) {
    return NextResponse.json(data); // {options: [{v,n,var}], total, agents}
  }
  return NextResponse.json({ options: data ?? [] });
}

// A15.B: the same options, but computed against the CURRENT filters ("Match my filters").
// POST rather than GET because the filter payload is a whole object and would not survive a
// query string. Falls back to the GET behaviour whenever scoping cannot help — see
// fn_facet_options: it drops the filter being built (so picking Miami does not collapse the
// city list to Miami), serves the precomputed lists when nothing else narrows or when the set
// is still most of the database, and only aggregates live in between.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("search");
  if (!gate.ok) return gate.response;

  const body = await req.json().catch(() => ({}));
  const type = typeof body?.type === "string" ? body.type : "";
  const field = typeof body?.field === "string" ? body.field : null;
  const q = typeof body?.q === "string" ? body.q : "";
  const scope = body?.scope === "office" ? "office" : "agent";
  const source = ["all", "courted", "zillow_realtor"].includes(body?.source) ? body.source : "all";
  const rawFilters = body?.filters && typeof body.filters === "object" ? body.filters : {};
  // fn_facet_options feeds the payload to fn_agent_where, which resolves saved-view references
  // under SECURITY DEFINER — so this route needs the same A12 gate as /api/search/filter.
  // Without it, any session could read facet lists scoped to someone else's private view.
  // Client references likewise (0124).
  const filters = restrictClientFilter(
    await sanitizeSavedViews(rawFilters, gate.user.id),
    await allowedClientIds(gate.user)
  );

  const admin = createAdminClient();
  // Office/Brand views run on fn_office_where, which fn_facet_options does not cover, so they
  // keep the unscoped lists rather than silently getting agent-grained answers.
  const useFacets = body?.matchFilters !== false && scope === "agent";

  const { data, error } = useFacets
    ? await admin.rpc("fn_facet_options", { p_type: type, p_q: q, p_field: field, p_source: source, p_filters: filters })
    : await admin.rpc("fn_search_options", { p_type: type, p_field: field, p_q: q, p_scope: scope, p_mls: null });

  if (error) {
    console.error("facet options RPC error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (type === "location" && data && !Array.isArray(data)) {
    return NextResponse.json({ ...data, scoped: useFacets });
  }
  return NextResponse.json({ options: data ?? [], scoped: useFacets });
}
