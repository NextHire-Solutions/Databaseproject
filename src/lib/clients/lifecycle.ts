// The client's LIFECYCLE status, read from the OS client record.
//
// orch_clients.status is a PIPELINE stage (new -> assigned -> ... -> live ->
// paused): it answers "how far through onboarding is this client", not "is this
// client still a client". The two even share the word `paused` and mean
// different things by it. So this database cannot answer "is this client
// churned" from its own tables, and asking it to would mean duplicating a field
// the OS already masters.
//
// The OS serves that answer at /api/workspace/clients/status-feed, the same
// feed MasterInbox uses to drive portals. We read it rather than keep a copy.
//
// ---------------------------------------------------------------------------
// FAIL-SAFE, IN THE DIRECTION OF LETTING WORK HAPPEN
//
// Every failure — env unset, feed down, timeout, non-200, unparseable, zero
// clients — resolves to "unknown", and an unknown client is NEVER blocked.
//
// That direction is deliberate. This gate exists to stop lead-building for a
// client who has left; it is not a safety interlock. Failing closed would mean
// a brief feed outage silently blocks an operator's import with a message about
// a client being churned when it isn't — turning a tidy-up rule into an outage.
// A churned client keeping its leads for one more import is a far smaller
// problem than an import that refuses to run for reasons nobody can see.
//
// Names are matched normalised, the same rule the OS feed, the portal sync and
// the campaign matcher all use. The feed emits one entry per known name — the
// master client's name plus every alias — so a client with several markets is
// matched whichever spelling orch_clients happens to hold.

const FEED_TIMEOUT_MS = 6000;
const CACHE_MS = 60_000;

export type Lifecycle = "active" | "paused" | "churned";

/** Same normalisation as the OS feed and the campaign matcher. */
const norm = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

interface Cached {
  at: number;
  byName: Map<string, Lifecycle> | null; // null = could not read
}
let cache: Cached = { at: 0, byName: null };

/**
 * normalised client name -> lifecycle status, or null when the feed could not
 * be read. Cached briefly: a CSV import arrives in many chunks and each one
 * would otherwise re-fetch.
 */
export async function loadLifecycle(): Promise<Map<string, Lifecycle> | null> {
  const now = Date.now();
  if (cache.byName && now - cache.at < CACHE_MS) return cache.byName;

  const url = process.env.CLIENT_STATUS_URL?.trim();
  const token = process.env.CLIENT_STATUS_TOKEN?.trim();
  if (!url || !token) return null; // not configured -> nothing is blocked

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "x-admin-token": token },
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = (await res.json()) as {
      clients?: Array<{ name?: string; status?: string }>;
    };
    const rows = data.clients ?? [];
    // An empty feed is a broken feed, not "every client is fine". Treating it
    // as authoritative would mark nothing churned, which is harmless here, but
    // caching it for a minute would hide a real outage.
    if (rows.length === 0) return null;

    const byName = new Map<string, Lifecycle>();
    for (const c of rows) {
      const name = (c.name ?? "").trim();
      const status = c.status;
      if (!name) continue;
      if (status !== "active" && status !== "paused" && status !== "churned") continue;
      byName.set(norm(name), status);
    }
    cache = { at: now, byName };
    return byName;
  } catch {
    return null; // down / timeout / unparseable -> nothing is blocked
  }
}

/**
 * The lifecycle status of one client by name, or null when unknown — which
 * covers both "the feed could not be read" and "the feed does not name this
 * client" (a client still onboarding is deliberately absent from it).
 */
export async function lifecycleOf(clientName: string | null | undefined): Promise<Lifecycle | null> {
  const name = (clientName ?? "").trim();
  if (!name) return null;
  const byName = await loadLifecycle();
  return byName?.get(norm(name)) ?? null;
}

/** True only when the OS positively says this client has churned. */
export async function isChurned(clientName: string | null | undefined): Promise<boolean> {
  return (await lifecycleOf(clientName)) === "churned";
}

/** Test seam: forget the cached feed. */
export function __resetLifecycleCache(): void {
  cache = { at: 0, byName: null };
}
