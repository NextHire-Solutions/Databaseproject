"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface OrchClientRow {
  id: string;
  client_name: string | null;
  status: string | null;
  mls: string | null;
  location: string | null;
  bison_campaign_id: string | null;
  leads_inreview: boolean;
  bison_leads_exported: boolean;
  lead_count: number;
  bison_leads?: number;
  bison_replied?: number;
  bison_bounced?: number; // C1: bounced leads in this client's campaigns
  /** Lifecycle status from the OS: active | paused | churned. Null = unknown. */
  lifecycle?: string | null;
  created_at: string;
}

const STATUS_TONE: Record<string, string> = {
  leads_built: "bg-green-100 text-green-800",
  onboarding: "bg-blue-100 text-blue-800",
  pending: "bg-neutral-100 text-neutral-700",
};

/*
 * The CLIENT lifecycle status, which is a different question from the pipeline
 * status beside it: that one says how far through onboarding a client is, this
 * one says whether they are still a client. §8 lists both as fields of this
 * view and only the pipeline one existed.
 *
 * Colours are the document's, not invented here: paused is orange and churned
 * is red (§11), so a client reads the same way in this list as anywhere else.
 */
const LIFECYCLE_TONE: Record<string, string> = {
  active: "bg-green-100 text-green-800",
  onboarding: "bg-blue-100 text-blue-800",
  paused: "bg-orange-100 text-orange-800",
  churned: "bg-red-100 text-red-800",
};

// Clients page (route kept at /webhooks) — a view of orch_clients, the shared table the
// orchestrator and other apps maintain. Clients appear here automatically when onboarded;
// "Add client" covers clients that only exist as a Bison campaign. Campaigns are matched by
// name ("Client Name + Sender + Market") and sends go through the in-house enrichment pipeline.
export default function ClientsPage() {
  const [clients, setClients] = useState<OrchClientRow[]>([]);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  async function load() {
    setLoading(true);
    const r = await fetch("/api/orch/clients");
    const j = await r.json();
    setClients(j.clients ?? []);
    setSyncedAt(j.campaignsSyncedAt ?? null);
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  // Triggers BOTH sequencers. This used to post to bison-sync alone, so there was no way to
  // refresh Instantly from the app at all — it only ever moved on the 6-hourly cron.
  //
  // They are fired independently on purpose: an EmailBison outage must not stop Instantly
  // refreshing, and vice versa. Both return 202 and do the real work in the background, so the
  // toast reports what was STARTED; the outcome lands in audit_logs.
  async function syncCampaigns() {
    setSyncing(true);
    const [bison, instantly] = await Promise.allSettled([
      fetch("/api/cron/bison-sync", { method: "POST" }).then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) })),
      fetch("/api/cron/instantly-sync", { method: "POST" }).then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) })),
    ]);
    setSyncing(false);

    const failed: string[] = [];
    const bisonOk = bison.status === "fulfilled" && bison.value.ok && !bison.value.j?.error;
    const instOk = instantly.status === "fulfilled" && instantly.value.ok && !instantly.value.j?.error;
    if (!bisonOk) {
      failed.push(
        `EmailBison — ${bison.status === "rejected" ? "request failed" : bison.value.j?.error ?? "sync failed"}`
      );
    }
    if (!instOk) {
      failed.push(
        `Instantly — ${instantly.status === "rejected" ? "request failed" : instantly.value.j?.error ?? "sync failed"}`
      );
    }

    if (failed.length === 2) {
      toast.error(`Both syncs failed. ${failed.join(" · ")}`, { duration: 9000 });
    } else if (failed.length === 1) {
      toast.warning(`Started one of two. ${failed[0]}`, { duration: 9000 });
    } else {
      const campaigns = bison.status === "fulfilled" ? bison.value.j?.campaigns ?? 0 : 0;
      toast.success(`Syncing ${campaigns} EmailBison campaigns and the Instantly workspace — this runs in the background.`);
    }
    load();
  }

  async function addClient() {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    const res = await fetch("/api/orch/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: name }),
    });
    const j = await res.json().catch(() => ({}));
    setAdding(false);
    if (!res.ok) {
      toast.error(j.error ?? "Failed to add client");
      return;
    }
    setAddOpen(false);
    setNewName("");
    toast.success(`Client "${name}" added — syncing campaigns…`);
    await syncCampaigns();
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">
            Clients
            {!loading && (
              <span className="ml-2 align-middle text-base font-normal text-neutral-400">
                {clients.length.toLocaleString()}
              </span>
            )}
          </h1>
          <p className="mt-0.5 text-sm text-neutral-500">
            Managed by the onboarding system — new clients appear here automatically. Campaigns match by name
            (“Client Name + Sender + Market”); sends enrich each agent, skip leads already in the client’s campaigns, then upload to
            EmailBison.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {syncedAt && <span className="text-xs text-neutral-400">Campaigns synced {new Date(syncedAt).toLocaleString()}</span>}
          <Button variant="outline" onClick={syncCampaigns} disabled={syncing} className="gap-1.5">
            {syncing ? "Syncing…" : "Sync campaigns"}
          </Button>
          <Button onClick={() => setAddOpen(true)}>Add client</Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-neutral-200 text-left text-xs font-medium text-neutral-500">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Client status</th>
              <th className="px-4 py-3">Onboarding status</th>
              <th className="px-4 py-3">MLS</th>
              <th className="px-4 py-3">Location</th>
              <th className="px-4 py-3 text-right">Leads built</th>
              <th className="px-4 py-3 text-right">In sequencers</th>
              {/* These counted EmailBison only, so they were labelled "(Bison)" to stop them
                  silently disagreeing with the agent table. Since 0111 they read
                  v_client_campaign_leads and cover both sequencers, so the qualifier is gone. */}
              <th className="px-4 py-3 text-right">Replied</th>
              <th className="px-4 py-3 text-right">Bounced</th>
              <th className="px-4 py-3">In review</th>
              <th className="px-4 py-3">Exported</th>
              <th className="px-4 py-3 text-right">Campaign ID</th>
              <th className="px-4 py-3">Onboarded</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={13} className="py-12 text-center text-neutral-400">
                  Loading…
                </td>
              </tr>
            ) : clients.length === 0 ? (
              <tr>
                <td colSpan={13} className="py-12 text-center text-neutral-400">
                  No clients yet — they appear here automatically once onboarded.
                </td>
              </tr>
            ) : (
              clients.map((c) => (
                <tr key={c.id} className="border-b border-neutral-100">
                  <td className="px-4 py-3 font-medium text-neutral-900">{c.client_name ?? "Unnamed client"}</td>
                  <td className="px-4 py-3">
                    {/* Nothing rather than a guess when the feed is unreadable:
                        an unknown status must never render as "active". */}
                    {c.lifecycle ? (
                      <Badge className={LIFECYCLE_TONE[c.lifecycle] ?? "bg-neutral-100 text-neutral-700"}>
                        {c.lifecycle}
                      </Badge>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge className={STATUS_TONE[c.status ?? ""] ?? "bg-neutral-100 text-neutral-700"}>{c.status ?? "—"}</Badge>
                  </td>
                  <td className="px-4 py-3 text-neutral-600">{c.mls ?? "—"}</td>
                  <td className="px-4 py-3 text-neutral-600">{c.location ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-800">{c.lead_count.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-600">{(c.bison_leads ?? 0).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {c.bison_replied ? <span className="text-green-700">{c.bison_replied.toLocaleString()}</span> : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {c.bison_bounced ? <span className="font-medium text-red-600">{c.bison_bounced.toLocaleString()}</span> : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {c.leads_inreview ? <Badge className="bg-amber-100 text-amber-800">In review</Badge> : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {c.bison_leads_exported ? <Badge className="bg-green-100 text-green-800">Exported</Badge> : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-600">{c.bison_campaign_id ?? "—"}</td>
                  <td className="px-4 py-3 text-neutral-500">{new Date(c.created_at).toLocaleDateString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) setNewName(""); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add client</DialogTitle>
            <DialogDescription>
              Use the same name as the client&apos;s EmailBison campaign — after adding, campaigns sync
              automatically and attach by name.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Client name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addClient();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={adding}>
              Cancel
            </Button>
            <Button onClick={addClient} disabled={adding || !newName.trim()}>
              {adding ? "Adding…" : "Add client"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
