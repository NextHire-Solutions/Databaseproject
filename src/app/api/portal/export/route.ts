import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/api/log-audit";
import { gatherExportRows } from "@/lib/export/gather-rows";
import { requirePermission } from "@/lib/api/require-permission";
import { allowedClientIds, allowedClientNames, restrictClientFilter } from "@/lib/auth/client-access";

export const maxDuration = 300;

// Export selected/filtered agents into a client's PORTAL (the Masterinbox client portal):
//   target 'agents' -> "Your Agents"  (POST {portal}/agents/csv — bulk, idempotent on email)
//   target 'dnc'    -> DNC list       (POST {portal}/dnc/csv   — bulk, idempotent)
// Both portal endpoints also push provider blocklists (Instantly + EmailBison) in the
// background, so the client's own agents / DNC entries can never be cold-emailed.
//
// The client is chosen from the portal's admin directory (see /api/portal/clients); the
// browser only ever sends the client NAME — the portal token is re-resolved here from the
// directory (GET /api/clients/portals with PORTAL_ADMIN_TOKEN) and never leaves the server.
const PORTAL_BASE = process.env.PORTAL_BASE_URL || "https://portal.brokerstaffer.com";
const CAP = 5000; // the portal bulk endpoints accept at most 5000 rows per call

interface PortalDirEntry {
  name: string;
  aliases?: string[];
  portal_token: string;
  portal_url: string;
  portal_enabled: boolean;
}

async function resolvePortal(portalClient: string): Promise<{ base: string; clientName: string } | { error: string }> {
  if (!process.env.PORTAL_ADMIN_TOKEN) return { error: "PORTAL_ADMIN_TOKEN is not configured" };
  const res = await fetch(`${PORTAL_BASE}/api/clients/portals`, {
    headers: { "x-admin-token": process.env.PORTAL_ADMIN_TOKEN },
    signal: AbortSignal.timeout(20000),
    cache: "no-store",
  });
  if (!res.ok) return { error: `portal directory lookup failed (${res.status})` };
  const dir = (await res.json().catch(() => null)) as { clients?: PortalDirEntry[] } | null;
  const want = portalClient.trim().toLowerCase();
  const hit = (dir?.clients ?? []).find(
    (p) => p.name?.trim().toLowerCase() === want || (p.aliases ?? []).some((a) => a?.trim().toLowerCase() === want)
  );
  if (!hit) return { error: `${portalClient} has no portal in the directory.` };
  if (!hit.portal_enabled) return { error: `${hit.name}'s portal is disabled.` };
  if (!hit.portal_url || !hit.portal_token) return { error: `${hit.name}'s portal has no URL/token yet.` };
  return { base: `${new URL(hit.portal_url).origin}/api/portal/${hit.portal_token}`, clientName: hit.name };
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("campaign.send");
  if (!gate.ok) return gate.response;

  const body = await req.json().catch(() => ({}));
  const { portalClient, target, mode = "agent", source = "courted", filters = {}, selectedIds, rangeFrom, rangeTo } = body ?? {};
  if (!portalClient || typeof portalClient !== "string") return NextResponse.json({ error: "portalClient required" }, { status: 400 });
  if (target !== "agents" && target !== "dnc") return NextResponse.json({ error: "target must be 'agents' or 'dnc'" }, { status: 400 });

  // 0124: a client-restricted account may only send to portals of its allowed clients, and
  // client references inside the filter payload are stripped like everywhere else.
  const allowed = await allowedClientIds(gate.user);
  let effFilters = filters as Record<string, unknown>;
  if (allowed !== null) {
    const allowedNames = await allowedClientNames(gate.user);
    if (!allowedNames?.has(String(portalClient).trim().toLowerCase())) {
      return NextResponse.json({ error: "You don't have access to this client's portal." }, { status: 403 });
    }
    effFilters = restrictClientFilter(effFilters, allowed);
  }

  const portal = await resolvePortal(portalClient);
  if ("error" in portal) return NextResponse.json({ error: portal.error }, { status: 400 });

  let rows: Record<string, unknown>[] = [];
  try {
    rows = await gatherExportRows({ mode, source, filters: effFilters, selectedIds, rangeFrom, rangeTo, userId: gate.user.id ?? null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to gather agents" }, { status: 500 });
  }
  if (rows.length === 0) return NextResponse.json({ error: "No agents to send." }, { status: 400 });
  if (rows.length > CAP) {
    return NextResponse.json({ error: `The portal accepts at most ${CAP.toLocaleString()} agents per send — you selected ${rows.length.toLocaleString()}. Narrow the selection.` }, { status: 400 });
  }

  // strings only, valid email or null (the portal validates hard); it dedups by email itself
  const clean = (v: unknown, max: number) => {
    const s = v == null ? "" : String(v).trim();
    return s ? s.slice(0, max) : null;
  };
  const emailOf = (r: Record<string, unknown>) => {
    const e = String(r.preferred_email || r.enriched_email || "").trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
  };

  const payloadRows =
    target === "agents"
      ? rows.map((r) => ({
          name: clean(r.full_name, 160) ?? "Unknown agent",
          email: emailOf(r),
          phone: clean(r.preferred_phone, 40),
          license: clean(r.license_number, 80),
        }))
      : rows.map((r) => ({
          kind: "agent" as const,
          name: clean(r.full_name, 160) ?? "Unknown agent",
          email: emailOf(r),
          phone: clean(r.preferred_phone, 40),
          brokerage: clean(r.office_name, 160) ?? clean(r.brand, 160),
          notes: "Added by BrokerStaffer",
        }));

  const res = await fetch(`${portal.base}/${target === "agents" ? "agents" : "dnc"}/csv`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rows: payloadRows }),
    signal: AbortSignal.timeout(120000),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; inserted?: number; pushScheduled?: number; error?: string };
  if (!res.ok) {
    return NextResponse.json({ error: j.error ?? `Portal rejected the send (HTTP ${res.status})` }, { status: 502 });
  }

  const inserted = j.inserted ?? 0;
  const already = payloadRows.length - inserted; // bulk upsert is idempotent — repeats are absorbed
  await logAudit({
    action: "portal_export",
    performedBy: gate.user.email ?? null,
    details: `Sent ${inserted} agents to ${portal.clientName}'s portal ${target === "agents" ? "Your Agents" : "DNC"}${already > 0 ? ` — ${already} already there` : ""}`,
    meta: { kind: "portal_export", portalClient: portal.clientName, target, sent: payloadRows.length, inserted, pushScheduled: j.pushScheduled ?? 0 },
  });
  return NextResponse.json({ ok: true, inserted, alreadyThere: Math.max(already, 0), total: payloadRows.length, client: portal.clientName });
}
