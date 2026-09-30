import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api/require-permission";
import { CLIENT_LIST } from "@/lib/auth/permissions";
import { allowedClientNames } from "@/lib/auth/client-access";

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

  // 0124: the RPC answers in NAMES (client_mls entries + saved-list names). A client-restricted
  // account gets only names matching its allowed clients — anything else, including saved-list
  // names that resemble other clients, stays hidden.
  const allowedNames = await allowedClientNames(gate.user);
  const names = (Array.isArray(data) ? (data as string[]) : []).filter(
    (n) => allowedNames === null || allowedNames.has(String(n).trim().toLowerCase())
  );
  return NextResponse.json({ clients: names });
}
