import { createHash } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import { canAny, type Permission } from "@/lib/auth/permissions";
import type { UserRole } from "@/types/auth";

// Who is making this request, and what may they do? Server-only (reads cookies, queries the DB).
// Shared by API routes (require-permission.ts), page guards (page-guard.ts) and the app layout,
// so all three always agree.

export type Caller = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole | null; // null = no user_profiles row -> no permissions
  active: boolean; //       false = deactivated -> no permissions
  clientAccess: "all" | "selected"; // 0124: 'selected' = only the clients in user_client_access
};

// Verifying a login token is a round-trip to Supabase Auth. Search fires a request per debounced
// filter change, so paying that every time put latency on the critical path (see the note in
// api/search/filter). Instead each token is verified ONCE and the answer kept in memory for up
// to TTL_MS. The cache key is a hash of the token itself, and only a token Supabase has just
// verified is ever stored — a forged token misses the cache, fails verification, and is refused.
// Cost: a role change or deactivation takes up to TTL_MS to apply to a session already in use.
const TTL_MS = 60_000;
const verified = new Map<string, { caller: Caller; until: number }>();

export async function getCaller(): Promise<Caller | null> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession(); // local cookie read; NOT trusted until verified below
  const token = session?.access_token;
  if (!token) return null;

  const now = Date.now();
  const key = createHash("sha256").update(token).digest("hex");
  const hit = verified.get(key);
  if (hit && hit.until > now) return hit.caller;

  const {
    data: { user },
  } = await supabase.auth.getUser(); // Supabase Auth verifies this token
  if (!user) return null;

  const { rows } = await getPool().query(
    "select email, full_name, role, is_active, client_access from user_profiles where id = $1",
    [user.id]
  );
  const p = rows[0] as
    | { email: string | null; full_name: string | null; role: string; is_active: boolean; client_access: string }
    | undefined;
  const caller: Caller = {
    id: user.id,
    email: p?.email ?? user.email ?? "",
    name: p?.full_name ?? null,
    clientAccess: p?.client_access === "selected" ? "selected" : "all",
    role: (p?.role ?? null) as UserRole | null,
    active: p ? p.is_active !== false : false,
  };

  // Never keep an answer past the token's own expiry.
  const exp = session?.expires_at ? session.expires_at * 1000 : now + TTL_MS;
  if (verified.size > 1000) {
    for (const [k, v] of verified) if (v.until <= now) verified.delete(k);
  }
  verified.set(key, { caller, until: Math.min(now + TTL_MS, exp) });
  return caller;
}

// True when the caller is active and holds at least one of the permissions.
export function callerCan(caller: Caller | null, anyOf: readonly Permission[]): boolean {
  return !!caller && caller.active && canAny(caller.role, anyOf);
}
