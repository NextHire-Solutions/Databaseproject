import { getPool } from "@/lib/db/pool";
import type { Caller } from "@/lib/auth/caller";

// Per-user client visibility (0124). The owner can limit a manager/viewer to specific clients;
// everywhere client data surfaces, these helpers decide what that account gets.
//
// null = unrestricted (owner, admin, or client_access = 'all') — callers skip filtering
// entirely, so the common case costs nothing. An empty array is a real answer: a restricted
// account with nothing ticked sees no clients. Fail-closed.

export async function allowedClientIds(caller: Caller): Promise<string[] | null> {
  if (caller.role === "owner" || caller.role === "admin") return null;
  if (caller.clientAccess !== "selected") return null;
  const { rows } = await getPool().query("select orch_client_id from user_client_access where user_id = $1", [
    caller.id,
  ]);
  return rows.map((r) => String(r.orch_client_id));
}

// The portal directory and fn_clients_for_mls deal in client NAMES, not ids — this is the same
// answer as allowedClientIds, resolved to lowercased names for those two surfaces.
export async function allowedClientNames(caller: Caller): Promise<Set<string> | null> {
  const ids = await allowedClientIds(caller);
  if (ids === null) return null;
  if (ids.length === 0) return new Set();
  const { rows } = await getPool().query(
    "select client_name from orch_clients where id = any($1::uuid[]) and client_name is not null",
    [ids]
  );
  return new Set(rows.map((r) => String(r.client_name).trim().toLowerCase()));
}

// A filter payload can reference clients directly (orchClientIds — the "In a client campaign"
// filter). A restricted account keeps only its allowed ids; anything else is stripped before
// the payload reaches the SECURITY DEFINER filter engine — the same treatment saved-view
// references get in sanitize-saved-views. Applied to live searches, exports, sends, AND filters
// being saved into a view, so a hand-crafted payload has nowhere to hide an off-limits id.
export function restrictClientFilter(
  filters: Record<string, unknown>,
  allowed: string[] | null
): Record<string, unknown> {
  if (allowed === null) return filters;
  const ids = filters?.orchClientIds;
  if (!Array.isArray(ids) || ids.length === 0) return filters;
  const ok = new Set(allowed);
  return { ...filters, orchClientIds: ids.filter((id) => typeof id === "string" && ok.has(id)) };
}
