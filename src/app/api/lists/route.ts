import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api/require-permission";

// Saved views (quick-filters): the user's saved filter selections.
// B4: each row carries its cached agent count (cached_count/cached_at — refreshed on
// save/edit, after imports, and by the 6-hourly sync); `totals` adds the across-all-views
// numbers (union = unique agents in at least one view; sum double-counts overlaps).
export async function GET() {
  const gate = await requirePermission("views");
  if (!gate.ok) return gate.response;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("saved_lists")
    .select("id, name, filters, mode, source_mode, created_at, cached_count, cached_at")
    .eq("user_id", gate.user.id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const totals = (await getPool().query("select union_count, sum_count, refreshed_at from saved_list_totals where id = 1")).rows[0] ?? null;
  return NextResponse.json({ lists: data ?? [], totals });
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("views");
  if (!gate.ok) return gate.response;
  const supabase = await createClient();

  const body = await req.json().catch(() => ({}));
  const name: string = (body?.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const { data, error } = await supabase
    .from("saved_lists")
    .insert({
      user_id: gate.user.id,
      name,
      filters: body?.filters ?? {},
      mode: body?.mode ?? "agent",
      source_mode: body?.source ?? "courted",
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // count the new view in the background — the response shouldn't wait on a full search
  void getPool().query("select fn_refresh_saved_list_counts($1::uuid[])", [[data.id]]).catch(() => {});
  return NextResponse.json({ id: data.id });
}
