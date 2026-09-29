import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api/require-permission";
import { sanitizeSavedViews } from "@/lib/filters/sanitize-saved-views";

// Agent/Office search. Calls fn_filter_search (SECURITY DEFINER) -> { data, totalCount, salesVolumeTotal }.
export async function POST(req: NextRequest) {
  try {
    // The results carry preferred_email/preferred_phone and paging is unbounded, so this is an
    // export surface in its own right — it gets the same server-side gate as everything else.
    // Cheap on the debounced-keystroke path: the caller lookup is cached (see lib/auth/caller).
    const gate = await requirePermission("search");
    if (!gate.ok) return gate.response;

    const body = await req.json().catch(() => ({}));
    const {
      mode = "agent",
      source = "courted",
      sortBy = "sales_volume",
      sortDir = "desc",
      page = 1,
      pageSize = 50,
      filters = {},
    } = body ?? {};

    const limit = Math.min(Number(pageSize) || 50, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    // saved-view include/exclude references are permission-gated to the caller's own/shared
    // views before they reach the SECURITY DEFINER RPC. Zero-cost when none are referenced
    // (the common case — sanitizeSavedViews returns immediately), and the caller identity
    // comes from the gate above rather than a second auth round-trip.
    const effFilters = await sanitizeSavedViews(filters, gate.user.id);

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("fn_filter_search", {
      p_mode: mode,
      p_source: source,
      p_filters: effFilters,
      p_sort_by: sortBy,
      p_sort_dir: sortDir,
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      console.error("search RPC error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      data: data?.data ?? [],
      totalCount: data?.totalCount ?? 0,
      salesVolumeTotal: data?.salesVolumeTotal ?? 0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
