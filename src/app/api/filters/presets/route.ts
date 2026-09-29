import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api/require-permission";

// GET /api/filters/presets — List user's presets + shared presets
export async function GET() {
  const gate = await requirePermission("views");
  if (!gate.ok) return gate.response;

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("filter_presets")
    .select("*")
    .or(`user_id.eq.${gate.user.id ?? ""},is_shared.eq.true`)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ presets: data });
}

// POST /api/filters/presets — Create a new preset
export async function POST(request: NextRequest) {
  const gate = await requirePermission("views");
  if (!gate.ok) return gate.response;

  let body: { name: string; filters: Record<string, unknown>; is_shared?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("filter_presets")
    .insert({
      user_id: gate.user.id,
      name: body.name.trim(),
      filters: body.filters,
      is_shared: body.is_shared ?? false,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ preset: data });
}

// DELETE /api/filters/presets — Delete a preset
export async function DELETE(request: NextRequest) {
  const gate = await requirePermission("views");
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("filter_presets")
    .delete()
    .eq("id", id)
    .eq("user_id", gate.user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
