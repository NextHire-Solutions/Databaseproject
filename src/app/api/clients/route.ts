import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api/require-permission";

// List clients (Bison key masked) + create a client. RLS: read = authenticated, write = manager+.
export async function GET() {
  const gate = await requirePermission("clients");
  if (!gate.ok) return gate.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, clay_webhook_url, bison_api_key, bison_synced_at")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const clients = (data ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    clay_webhook_url: c.clay_webhook_url,
    bison_key_set: !!c.bison_api_key,
    bison_synced_at: c.bison_synced_at,
  }));
  return NextResponse.json({ clients });
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("clients");
  if (!gate.ok) return gate.response;

  const supabase = await createClient();
  const body = await req.json().catch(() => ({}));
  const name: string = (body?.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const { data, error } = await supabase
    .from("clients")
    .insert({ name, clay_webhook_url: body?.clay_webhook_url || null, bison_api_key: body?.bison_api_key || null })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id });
}
