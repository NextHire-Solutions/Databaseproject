import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api/require-permission";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePermission("views");
  if (!gate.ok) return gate.response;
  const supabase = await createClient();
  const { error } = await supabase.from("saved_lists").delete().eq("id", id).eq("user_id", gate.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // across-all-views totals just lost a member (B4)
  void getPool().query("select fn_refresh_saved_list_counts('{}'::uuid[])").catch(() => {});
  return NextResponse.json({ ok: true });
}

// Update a saved view's name and/or filters.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requirePermission("views");
  if (!gate.ok) return gate.response;
  const supabase = await createClient();
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (body?.filters !== undefined) patch.filters = body.filters;
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  const { error } = await supabase.from("saved_lists").update(patch).eq("id", id).eq("user_id", gate.user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // recount in the background if the membership definition changed (B4)
  if (patch.filters !== undefined) {
    void getPool().query("select fn_refresh_saved_list_counts($1::uuid[])", [[id]]).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
