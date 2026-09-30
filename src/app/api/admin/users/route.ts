import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/api/require-admin";

// List all user profiles for the Admin > Users tab.
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { rows } = await getPool().query(
    `select id, email, full_name, role, is_active, created_at, client_access,
            (select count(*)::int from user_client_access a where a.user_id = user_profiles.id) as client_count
       from user_profiles order by created_at`
  );
  return NextResponse.json({ users: rows });
}
