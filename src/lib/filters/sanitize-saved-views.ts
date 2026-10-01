import { getPool } from "@/lib/db/pool";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A12 permission gate: a filter payload may reference saved views to include/exclude by. The
// filter engine (fn_agent_where) resolves them under SECURITY DEFINER, bypassing RLS, so this
// strips any referenced view the caller may not use (not their own and not shared) BEFORE the
// payload reaches the RPC — a user must never include/exclude by someone else's private view.
// Returns the filters unchanged when no views are referenced (the common case — zero cost).
export async function sanitizeSavedViews(
  filters: Record<string, unknown>,
  userId: string | null
): Promise<Record<string, unknown>> {
  const sv = filters?.savedViews as { include?: unknown; exclude?: unknown } | undefined;
  const include = (Array.isArray(sv?.include) ? sv.include : []).filter((i): i is string => typeof i === "string" && UUID.test(i));
  const exclude = (Array.isArray(sv?.exclude) ? sv.exclude : []).filter((i): i is string => typeof i === "string" && UUID.test(i));
  if (include.length === 0 && exclude.length === 0) {
    return sv ? { ...filters, savedViews: { include: [], exclude: [] } } : filters;
  }
  if (!userId) return { ...filters, savedViews: { include: [], exclude: [] } };

  const ids = [...new Set([...include, ...exclude])];
  // Owners/admins share one pool of views (they all see the same list), so they may reference
  // any view; everyone else only their own or explicitly shared ones.
  const { rows } = await getPool().query(
    `select id::text from saved_lists
      where id = any($1::uuid[])
        and (user_id = $2 or is_shared = true
             or exists (select 1 from user_profiles p where p.id = $2 and p.role in ('owner','admin')))`,
    [ids, userId]
  );
  const allowed = new Set(rows.map((r) => r.id as string));
  return {
    ...filters,
    savedViews: {
      include: include.filter((i) => allowed.has(i)),
      exclude: exclude.filter((i) => allowed.has(i)),
    },
  };
}
