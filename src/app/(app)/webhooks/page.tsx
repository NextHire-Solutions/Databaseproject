"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
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
  saved_views?: number; //       0125: saved views attached to this client
  saved_view_agents?: number; //  sum of those views' cached agent counts
  /** Lifecycle status from the OS: active | paused | churned. Null = unknown. */
  lifecycle?: string | null;
  created_at: string;
}

// Sortable numeric/date columns. Each maps a row to a comparable number.
type SortKey = "bison_leads" | "saved_views" | "saved_view_agents" | "bison_replied" | "bison_bounced" | "created_at";
const SORT_VALUE: Record<SortKey, (c: OrchClientRow) => number> = {
  bison_leads: (c) => c.bison_leads ?? 0,
  saved_views: (c) => c.saved_views ?? 0,
  saved_view_agents: (c) => c.saved_view_agents ?? 0,
  bison_replied: (c) => c.bison_replied ?? 0,
  bison_bounced: (c) => c.bison_bounced ?? 0,
  created_at: (c) => new Date(c.created_at).getTime(),
};

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
  // sort + status filters (client-side — ~50 rows)
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "created_at", dir: "desc" });
  const [clientStatus, setClientStatus] = useState("all"); // lifecycle: active | paused | churned | unknown
  const [onboardStatus, setOnboardStatus] = useState("all"); // c.status

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  }

  // the dropdown choices come from the data, so a new status value shows up on its own
  const clientStatusOpts = useMemo(
    () => Array.from(new Set(clients.map((c) => c.lifecycle || "unknown"))).sort(),
    [clients]
  );
  const onboardStatusOpts = useMemo(
    () => Array.from(new Set(clients.map((c) => c.status || "—"))).sort(),
    [clients]
  );

  const visible = useMemo(() => {
    const filtered = clients.filter((c) => {
      if (clientStatus !== "all" && (c.lifecycle || "unknown") !== clientStatus) return false;
      if (onboardStatus !== "all" && (c.status || "—") !== onboardStatus) return false;
      return true;
    });
    const val = SORT_VALUE[sort.key];
    return [...filtered].sort((a, b) => (sort.dir === "asc" ? val(a) - val(b) : val(b) - val(a)));
  }, [clients, clientStatus, onboardStatus, sort]);

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

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-neutral-500">
          Client status
          <select
            value={clientStatus}
            onChange={(e) => setClientStatus(e.target.value)}
            className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-700 focus:border-neutral-400 focus:outline-none"
          >
            <option value="all">All</option>
            {clientStatusOpts.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-neutral-500">
          Onboarding status
          <select
            value={onboardStatus}
            onChange={(e) => setOnboardStatus(e.target.value)}
            className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-700 focus:border-neutral-400 focus:outline-none"
          >
            <option value="all">All</option>
            {onboardStatusOpts.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        {(clientStatus !== "all" || onboardStatus !== "all") && (
          <button
            type="button"
            onClick={() => { setClientStatus("all"); setOnboardStatus("all"); }}
            className="text-xs text-neutral-500 hover:underline"
          >
            Clear filters · {visible.length} of {clients.length}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-neutral-200 text-left text-xs font-medium text-neutral-500">
            <tr>
              <th className="px-4 py-3">Client</th>
              <th className="px-4 py-3">Client status</th>
              <th className="px-4 py-3">Onboarding status</th>
              <th className="px-4 py-3">MLS</th>
              <SortTh label="In sequencers" k="bison_leads" sort={sort} onSort={toggleSort} />
              <SortTh label="Saved views" k="saved_views" sort={sort} onSort={toggleSort} />
              <SortTh label="View agents" k="saved_view_agents" sort={sort} onSort={toggleSort} />
              {/* These counted EmailBison only, so they were labelled "(Bison)" to stop them
                  silently disagreeing with the agent table. Since 0111 they read
                  v_client_campaign_leads and cover both sequencers, so the qualifier is gone. */}
              <SortTh label="Replied" k="bison_replied" sort={sort} onSort={toggleSort} />
              <SortTh label="Bounced" k="bison_bounced" sort={sort} onSort={toggleSort} />
              <SortTh label="Onboarded" k="created_at" sort={sort} onSort={toggleSort} />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="py-12 text-center text-neutral-400">
                  Loading…
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={10} className="py-12 text-center text-neutral-400">
                  {clients.length === 0
                    ? "No clients yet — they appear here automatically once onboarded."
                    : "No clients match the selected filters."}
                </td>
              </tr>
            ) : (
              visible.map((c) => (
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
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-600">{(c.bison_leads ?? 0).toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-800">
                    {c.saved_views ? c.saved_views.toLocaleString() : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-neutral-600">
                    {c.saved_view_agents ? c.saved_view_agents.toLocaleString() : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {c.bison_replied ? <span className="text-green-700">{c.bison_replied.toLocaleString()}</span> : <span className="text-neutral-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {c.bison_bounced ? <span className="font-medium text-red-600">{c.bison_bounced.toLocaleString()}</span> : <span className="text-neutral-400">—</span>}
                  </td>
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

// A right-aligned, clickable column header. Shows a neutral arrow until it's the active sort,
// then the direction. Click toggles asc/desc.
function SortTh({
  label,
  k,
  sort,
  onSort,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
}) {
  const active = sort.key === k;
  return (
    <th className="px-4 py-3 text-right">
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`ml-auto inline-flex items-center gap-1 hover:text-neutral-800 ${active ? "text-neutral-800" : ""}`}
        title={`Sort by ${label}`}
      >
        {label}
        {active ? (
          sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 text-neutral-300" />
        )}
      </button>
    </th>
  );
}
