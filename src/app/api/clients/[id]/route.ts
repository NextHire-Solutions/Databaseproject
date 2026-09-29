import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api/require-permission";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("clients");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const supabase = await createClient();
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (typeof body?.name === "string") patch.name = body.name.trim();
  if (typeof body?.clay_webhook_url === "string") patch.clay_webhook_url = body.clay_webhook_url || null;
  // Only overwrite the Bison key when a non-empty value is supplied (keeps it masked otherwise).
  if (typeof body?.bison_api_key === "string" && body.bison_api_key.trim()) patch.bison_api_key = body.bison_api_key.trim();
  if (Object.keys(patch).length === 0) return NextResponse.json({ ok: true });
  const { error } = await supabase.from("clients").update(patch).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("clients");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const supabase = await createClient();
  const { error } = await supabase.from("clients").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
