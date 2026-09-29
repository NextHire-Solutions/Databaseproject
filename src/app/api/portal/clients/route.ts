import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/require-permission";

// The client dropdown for portal sends. Proxies the portal's admin directory
// (GET {portal}/api/clients/portals, x-admin-token) and returns ONLY names + enabled —
// portal tokens never reach the browser; /api/portal/export re-resolves them server-side.
const PORTAL_BASE = process.env.PORTAL_BASE_URL || "https://portal.brokerstaffer.com";

export async function GET() {
  const gate = await requirePermission("campaign.send");
  if (!gate.ok) return gate.response;

  if (!process.env.PORTAL_ADMIN_TOKEN) {
    return NextResponse.json({ error: "PORTAL_ADMIN_TOKEN is not configured" }, { status: 500 });
  }
  const res = await fetch(`${PORTAL_BASE}/api/clients/portals`, {
    headers: { "x-admin-token": process.env.PORTAL_ADMIN_TOKEN },
    signal: AbortSignal.timeout(20000),
    cache: "no-store",
  });
  if (!res.ok) return NextResponse.json({ error: `portal directory lookup failed (${res.status})` }, { status: 502 });
  const dir = (await res.json().catch(() => null)) as {
    clients?: { name?: string; portal_enabled?: boolean }[];
  } | null;
  const clients = (dir?.clients ?? [])
    .filter((c) => c.name)
    .map((c) => ({ name: c.name as string, enabled: c.portal_enabled === true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ clients });
}
