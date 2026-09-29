import { NextResponse } from "next/server";
import { getCaller, type Caller } from "@/lib/auth/caller";
import { canAny, type Permission } from "@/lib/auth/permissions";

export type Gate = { ok: true; user: Caller } | { ok: false; response: NextResponse };

// The server-side permission check for an API route. Holding ANY one of the listed permissions
// is enough. Hiding a button is not protection — the route is reachable without it — so every
// route that reads or changes data starts with this.
//
//   const gate = await requirePermission("export");
//   if (!gate.ok) return gate.response;
//   // gate.user.id, gate.user.email
export async function requirePermission(...anyOf: Permission[]): Promise<Gate> {
  const caller = await getCaller();
  if (!caller) {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  if (!caller.active) {
    return { ok: false, response: NextResponse.json({ error: "This account is disabled." }, { status: 403 }) };
  }
  if (!canAny(caller.role, anyOf)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "You don't have permission to do this." }, { status: 403 }),
    };
  }
  return { ok: true, user: caller };
}
