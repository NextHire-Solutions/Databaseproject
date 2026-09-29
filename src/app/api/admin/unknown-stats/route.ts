import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { requirePermission } from "@/lib/api/require-permission";

const supabaseAdmin = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  try {
    const gate = await requirePermission("admin");
    if (!gate.ok) return gate.response;
    const { data, error } = await supabaseAdmin.rpc("fn_unknown_lead_stats");
    if (error) throw new Error(error.message);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get stats" },
      { status: 500 }
    );
  }
}
