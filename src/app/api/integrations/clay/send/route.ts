import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/api/log-audit";
import { orderedKeys } from "@/lib/export/columns";
import { gatherExportRows } from "@/lib/export/gather-rows";
import { sendRowsToClay, statusNote } from "@/lib/integrations/clay-send";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api/require-permission";

export const maxDuration = 300;

// Export -> Send to Clay: post the filtered (or selected) agents to a client's Clay webhook.
// Body: { clientId, campaignId?, campaignName?, mode?, source?, filters?, selectedIds?, rangeFrom?, rangeTo? }
export async function POST(req: NextRequest) {
  const gate = await requirePermission("campaign.send");
  if (!gate.ok) return gate.response;
  const supabase = await createClient();

  const body = await req.json().catch(() => ({}));
  const { clientId, campaignId = null, campaignName = null, mode = "agent", source = "courted", filters = {}, selectedIds, rangeFrom, rangeTo, columns } = body ?? {};
  if (!clientId) return NextResponse.json({ error: "clientId required" }, { status: 400 });
  const keys = orderedKeys(columns);

  const { data: client } = await supabase.from("clients").select("name, clay_webhook_url").eq("id", clientId).single();
  if (!client?.clay_webhook_url) return NextResponse.json({ error: "This client has no Clay webhook configured." }, { status: 400 });
  const webhookUrl: string = client.clay_webhook_url;
  const clientName: string = client.name ?? "";

  // ---- gather AGENT rows (Office mode -> every agent in the chosen offices) ----
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await gatherExportRows({ mode, source, filters, selectedIds, rangeFrom, rangeTo, userId: gate.user.id ?? null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to gather agents" }, { status: 500 });
  }

  if (rows.length === 0) return NextResponse.json({ error: "No agents to send." }, { status: 400 });

  // ---- post each agent to the client's Clay webhook as its own row (>=5 req/sec, retried) ----
  const { sent, failed, failedIds, statusCounts } = await sendRowsToClay(webhookUrl, rows, keys, { clientName, campaignId, campaignName });
  const note = statusNote(statusCounts);

  // Recovery data so the Activity log can re-send ONLY the failed agents later.
  const meta = { kind: "clay_send", clientId, campaignId, campaignName, source, columns: keys, failedIds };

  if (sent === 0) {
    await logAudit({
      action: "clay_send",
      performedBy: gate.user.email ?? null,
      details: `Sent 0 agents to ${client.name}'s Clay — all ${failed} failed${note}`,
      meta,
    });
    return NextResponse.json({ error: `Clay webhook rejected all rows.${note}`, failed }, { status: 502 });
  }

  await logAudit({
    action: "clay_send",
    performedBy: gate.user.email ?? null,
    details: `Sent ${sent} agents (one row each) to ${client.name}'s Clay${campaignName ? ` (campaign: ${campaignName})` : ""}${failed ? ` — ${failed} failed${note}` : ""}`,
    meta,
  });
  return NextResponse.json({ ok: true, sent, failed, client: client.name });
}
