import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api/require-permission";
import { CLIENT_LIST } from "@/lib/auth/permissions";

// "Current clients using this MLS": seed list (client_mls) + saved lists that selected the MLS.
export async function POST(req: NextRequest) {
  const gate = await requirePermission(...CLIENT_LIST);
  if (!gate.ok) return gate.response;

  const body = await req.json().catch(() => ({}));
  const mlsIds: string[] = Array.isArray(body?.mlsIds) ? body.mlsIds : [];
  if (mlsIds.length === 0) return NextResponse.json({ clients: [] });

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_clients_for_mls", { p_mls_ids: mlsIds });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clients: data ?? [] });
}
