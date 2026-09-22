"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Filters } from "@/types/agent-filters";
import type { DataSource, SearchMode } from "@/types/agent";
import { EXPORT_COLUMNS } from "@/lib/export/columns";
import { EXPORT_MAX_ROWS, SEND_CONFIRM_THRESHOLD } from "@/lib/export/limits";

interface PortalClientOpt {
  name: string;
  enabled: boolean;
}
interface Campaign {
  id: string; // bison_campaigns.id (internal UUID key — unique per campaign)
  bison_campaign_id: string;
  bison_id: string; // EmailBison's numeric campaign id (the id the send expects)
  name: string | null;
  status: string | null;
  client_id: string | null; // which selected client this campaign belongs to
  client_name: string | null;
  is_default: boolean; // the client's designated campaign (orch_clients.bison_campaign_id)
}

const ALL_KEYS = EXPORT_COLUMNS.map((c) => c.key);

export function ExportDialog({
  open,
  onOpenChange,
  filters,
  total,
  selectedIds,
  source,
  mode = "agent",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  filters: Filters;
  total: number;
  selectedIds: string[];
  source: DataSource;
  mode?: SearchMode;
}) {
  const [method, setMethod] = useState<"campaign" | "csv" | "portal">("campaign");
  const [sourcePriority, setSourcePriority] = useState<"courted" | "zillow" | "realtor">("courted");
  // #4: which MLS's production numbers feed the campaign variables — [] = all combined
  const [mlsScopeSel, setMlsScopeSel] = useState<string[]>([]);
  const [mlsOpts, setMlsOpts] = useState<{ id: string; code: string | null; name: string | null; ready?: boolean; agents?: number }[] | null>(null);
  const [portalTarget, setPortalTarget] = useState<"agents" | "dnc">("agents");
  const [portalClients, setPortalClients] = useState<PortalClientOpt[]>([]);
  const [portalClient, setPortalClient] = useState("");
  const [portalErr, setPortalErr] = useState<string | null>(null);
  // Campaign method has its OWN multi-select client picker showing ALL clients (independent of
  // the main filter). It's pre-seeded from the clients chosen in the filter but fully editable.
  // The chosen clients drive which campaigns are offered (grouped per client). The rows exported
  // are still the current filtered list.
  const [allClients, setAllClients] = useState<{ id: string; client_name: string | null; lead_count: number }[]>([]);
  const [clientQ, setClientQ] = useState(""); // search box over the client picker
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaigns, setSelectedCampaigns] = useState<Set<string>>(new Set()); // bison_campaigns.id
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const knownCampaignIds = useRef<Set<string>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cols, setCols] = useState<Set<string>>(new Set(ALL_KEYS));
  const [busy, setBusy] = useState(false);
  const [confirmedBig, setConfirmedBig] = useState(false); // A14b: explicit opt-in for large campaign sends

  // Portal clients come from the portal's own admin directory (names only — tokens stay
  // server-side); fetched lazily the first time the portal method is picked.
  useEffect(() => {
    if (open && method === "portal" && portalClients.length === 0) {
      setPortalErr(null);
      fetch("/api/portal/clients")
        .then((r) => r.json())
        .then((j) => {
          if (j.error) setPortalErr(j.error);
          else setPortalClients(j.clients ?? []);
        })
        .catch(() => setPortalErr("Could not reach the client portal"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, method]);

  // Seed the export's client selection from the filter each time the dialog opens (editable
  // after) — but NOT when the filter is excluding those clients (excluded clients are the ones
  // the operator explicitly does NOT want to touch). Campaign picks start fresh per open.
  useEffect(() => {
    if (open) {
      setConfirmedBig(false);
      setSelectedClientIds(new Set(filters.orchClientMode === "exclude" ? [] : filters.orchClientIds ?? []));
      setSelectedCampaigns(new Set());
      knownCampaignIds.current = new Set();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // All clients (independent of the filter) for the export's own client picker.
  useEffect(() => {
    if (!open || method !== "campaign") return;
    fetch("/api/orch/clients")
      .then((r) => r.json())
      .then((j) => setAllClients(j.clients ?? []))
      .catch(() => setAllClients([]));
  }, [open, method]);

  // "MLS data to send" offers only the MLSs present in THIS agent set (filters or explicit
  // selection), with each MLS's agent count — not all 34 in the system.
  useEffect(() => {
    if (!open || method !== "campaign") return;
    let active = true;
    setMlsOpts(null);
    fetch("/api/search/mls-in-set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, filters, selectedIds: selectedIds.length ? selectedIds : undefined }),
    })
      .then((r) => r.json())
      .then((j) => active && setMlsOpts(Array.isArray(j.options) ? j.options : []))
      .catch(() => active && setMlsOpts([]));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, method, source, JSON.stringify(filters), selectedIds.length]);

  // Load campaigns for the currently-selected clients (grouped per client). Keeps still-valid
  // campaign picks and pre-checks the default campaign of any newly-added client.
  // Latest-wins: rapid client toggles fire overlapping fetches; only the newest response may
  // apply, or a stale one can resurrect a deselected client's campaigns (and auto-check its
  // default — leads would go to a campaign the operator deselected).
  // Switching method away and back deliberately does NOT reset state — the operator's campaign
  // picks (including deliberately UNchecked defaults) must survive a peek at the CSV tab.
  const campaignsReqSeq = useRef(0);
  const clientKey = [...selectedClientIds].sort().join(",");
  useEffect(() => {
    if (!open || method !== "campaign") return;
    const seq = ++campaignsReqSeq.current;
    if (selectedClientIds.size === 0) {
      setCampaigns([]);
      setSelectedCampaigns(new Set());
      knownCampaignIds.current = new Set();
      setLoadingCampaigns(false);
      return;
    }
    setLoadingCampaigns(true);
    fetch(`/api/bison/campaigns?orchClientIds=${encodeURIComponent(clientKey)}`)
      .then((r) => r.json())
      .then((j) => {
        if (seq !== campaignsReqSeq.current) return; // stale response — a newer fetch owns the state
        const list: Campaign[] = j.campaigns ?? [];
        setCampaigns(list);
        setSelectedCampaigns((prev) => {
          const present = new Set(list.map((c) => c.id));
          const next = new Set([...prev].filter((id) => present.has(id))); // keep valid picks
          for (const c of list) if (c.is_default && !knownCampaignIds.current.has(c.id)) next.add(c.id); // default-check new clients
          return next;
        });
        knownCampaignIds.current = new Set(list.map((c) => c.id));
      })
      .catch(() => {
        if (seq !== campaignsReqSeq.current) return;
        setCampaigns([]);
        setSelectedCampaigns(new Set());
      })
      .finally(() => {
        if (seq === campaignsReqSeq.current) setLoadingCampaigns(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, method, clientKey]);

  // In Office mode the export is "all agents belonging to the chosen offices".
  const office = mode === "office";
  const hasSel = selectedIds.length > 0;

  // A14b: say what will ACTUALLY go out. gatherExportRows caps every export/send at
  // EXPORT_MAX_ROWS, but this line used to read "all 1,130,286 agents" while the server
  // quietly sent the first 100,000 — the count and the action disagreed, with no warning.
  // Ranges narrow the request first; an explicit row selection bypasses the cap entirely
  // (the caller asked for exactly those ids), so it is reported as-is.
  const rangeCount = from || to ? Math.max((Number(to) || total) - (Number(from) || 1) + 1, 0) : total;
  const requested = hasSel ? selectedIds.length : rangeCount;
  const willSend = hasSel ? requested : Math.min(requested, EXPORT_MAX_ROWS);
  const isCapped = !hasSel && requested > EXPORT_MAX_ROWS;

  const scope = hasSel
    ? office
      ? `all agents in ${selectedIds.length} selected office${selectedIds.length > 1 ? "s" : ""}`
      : `${selectedIds.length.toLocaleString()} selected agents`
    : office
    ? `agents from ${Math.min(rangeCount, EXPORT_MAX_ROWS).toLocaleString()} offices${isCapped ? ` (of ${rangeCount.toLocaleString()})` : ""}`
    : isCapped
    ? `${EXPORT_MAX_ROWS.toLocaleString()} of ${requested.toLocaleString()} agents`
    : from || to
    ? `agents ${from || 1}–${to || total}`
    : `all ${total.toLocaleString()} agents`;

  // Campaign sends cost real money per agent (BetterEnrich + Instantly + OpenAI) and put leads
  // into a live sending domain, so a big one has to be confirmed deliberately. CSV downloads and
  // the portal path don't need this — the portal enforces its own 5,000 cap server-side.
  const needsConfirm = method === "campaign" && willSend > SEND_CONFIRM_THRESHOLD;

  const reqBody = () => ({
    mode,
    source,
    filters,
    selectedIds: selectedIds.length ? selectedIds : undefined,
    rangeFrom: from || undefined,
    rangeTo: to || undefined,
  });
  const toggleCol = (k: string) =>
    setCols((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const toggleCampaign = (id: string) =>
    setSelectedCampaigns((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleClient = (id: string) =>
    setSelectedClientIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Client picker search. Selection is kept across searches: filtering the list never
  // deselects a client you already chose, it only changes what is visible.
  const shownClients = clientQ.trim()
    ? allClients.filter((c) => (c.client_name ?? "Unnamed client").toLowerCase().includes(clientQ.trim().toLowerCase()))
    : allClients;

  // Group the selected clients' campaigns under each client for the grouped multi-select.
  // Groups carry their client_id key — two clients can share a display name.
  const campaignGroups = Object.values(
    campaigns.reduce((acc, c) => {
      const key = c.client_id ?? c.client_name ?? "unknown";
      (acc[key] ??= { key, clientName: c.client_name ?? "Client", items: [] as Campaign[] }).items.push(c);
      return acc;
    }, {} as Record<string, { key: string; clientName: string; items: Campaign[] }>)
  );
  const withCampaigns = new Set(campaigns.map((c) => c.client_id));
  const missingCount = [...selectedClientIds].filter((id) => !withCampaigns.has(id)).length;

  // Send to campaign: queues the merged agent list as ONE enrichment batch targeting every
  // chosen campaign (across the selected clients). The enrich-worker finds + verifies an email
  // for each agent (cached results reused), then attaches the lead to each chosen campaign,
  // skipping a campaign only if the agent is already in another campaign of that campaign's
  // own client (per-campaign, per-client dedup).
  async function sendCampaign() {
    const chosen = campaigns.filter((c) => selectedCampaigns.has(c.id));
    if (chosen.length === 0) {
      toast.error("Select at least one campaign");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/enrichment/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...reqBody(),
        orchClientIds: [...selectedClientIds],
        campaigns: chosen.map((c) => ({ id: c.bison_id, name: c.name, clientId: c.client_id })),
        sourcePriority,
        mlsScope: mlsScopeSel.length ? mlsScopeSel : undefined,
      }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success(`Queued ${j.queued} agents — enriching now, then into ${chosen.length} campaign${chosen.length > 1 ? "s" : ""}. Track progress in Admin → Activity.`, { duration: 8000 });
      onOpenChange(false);
    } else {
      toast.error(j.error ?? "Send failed");
    }
  }

  // Client portal: writes the agents into the client's portal — "Your Agents" roster or the
  // DNC list. Both are idempotent on the portal side and also blocklist the emails on the
  // sending tools so these people can never be cold-emailed for that client.
  async function sendPortal() {
    if (!portalClient) {
      toast.error("Select a client");
      return;
    }
    setBusy(true);
    const res = await fetch("/api/portal/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...reqBody(), portalClient, target: portalTarget }),
    });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success(
        `Added ${j.inserted} agents to ${j.client}'s ${portalTarget === "agents" ? "Your Agents" : "DNC list"}${j.alreadyThere ? ` — ${j.alreadyThere} were already there` : ""}.`,
        { duration: 8000 }
      );
      onOpenChange(false);
    } else {
      toast.error(j.error ?? "Portal send failed");
    }
  }

  async function downloadCsv() {
    if (cols.size === 0) {
      toast.error("Select at least one column");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/export/csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...reqBody(), columns: [...cols] }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(j.error ?? "CSV export failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "brokerstaffer-agents.csv";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("CSV downloaded");
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Export agents</DialogTitle>
        </DialogHeader>
        <div className="max-h-[75vh] min-w-0 space-y-4 overflow-y-auto pr-1">
          {/* method */}
          <div>
            <label className="text-sm font-medium text-neutral-700">Method</label>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              {([["campaign", "Send to campaign"], ["csv", "Download CSV"], ["portal", "Client portal"]] as const).map(([m, lbl]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                    method === m ? "border-neutral-900 bg-brand text-white" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
                  )}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          {/* campaign options */}
          {method === "campaign" && (
            <>
              {/* Clients — multi-select, ALL clients, pre-seeded from the filter but editable */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-neutral-700">
                    Clients{" "}
                    <span className="font-normal text-neutral-400">
                      ({selectedClientIds.size} of {allClients.length} selected
                      {clientQ.trim() ? ` · ${shownClients.length} shown` : ""})
                    </span>
                  </label>
                  <div className="flex gap-3 text-xs">
                    {/* Select all acts on the rows currently LISTED, so it composes with the
                        search instead of silently selecting clients you cannot see. */}
                    <button type="button" className="text-neutral-600 hover:underline" onClick={() => setSelectedClientIds((prev) => new Set([...prev, ...shownClients.map((c) => c.id)]))}>
                      Select all
                    </button>
                    <button type="button" className="text-neutral-600 hover:underline" onClick={() => setSelectedClientIds(new Set())}>
                      Clear
                    </button>
                  </div>
                </div>
                {allClients.length > 8 && (
                  <input
                    value={clientQ}
                    onChange={(e) => setClientQ(e.target.value)}
                    placeholder="Search clients…"
                    className="mt-1.5 h-8 w-full rounded-lg border border-neutral-300 px-3 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
                  />
                )}
                <div className="mt-1.5 max-h-40 space-y-1 overflow-auto rounded-lg border border-neutral-200 p-3">
                  {allClients.length === 0 ? (
                    <p className="py-3 text-center text-sm text-neutral-400">No clients yet.</p>
                  ) : shownClients.length === 0 ? (
                    <p className="py-3 text-center text-sm text-neutral-400">No clients match.</p>
                  ) : (
                    shownClients.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm text-neutral-800">
                        <Checkbox checked={selectedClientIds.has(c.id)} onCheckedChange={() => toggleClient(c.id)} />
                        <span className="min-w-0 flex-1 truncate" title={c.client_name ?? "Unnamed client"}>{c.client_name ?? "Unnamed client"}</span>
                        <span className="shrink-0 text-xs text-neutral-400">{(c.lead_count ?? 0).toLocaleString()} leads</span>
                      </label>
                    ))
                  )}
                </div>
              </div>

              {/* Campaigns — grouped by the selected clients */}
              {selectedClientIds.size === 0 ? (
                <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-3 py-4 text-sm text-neutral-600">
                  Select one or more clients above to choose their campaigns.
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-neutral-700">
                      Campaigns <span className="font-normal text-neutral-400">({selectedCampaigns.size} selected)</span>
                    </label>
                    <div className="flex gap-3 text-xs">
                      <button type="button" className="text-neutral-600 hover:underline" onClick={() => setSelectedCampaigns(new Set(campaigns.map((c) => c.id)))}>
                        Select all
                      </button>
                      <button type="button" className="text-neutral-600 hover:underline" onClick={() => setSelectedCampaigns(new Set())}>
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="mt-1.5 max-h-56 space-y-3 overflow-auto rounded-lg border border-neutral-200 p-3">
                    {loadingCampaigns ? (
                      <p className="py-4 text-center text-sm text-neutral-400">Loading campaigns…</p>
                    ) : campaigns.length === 0 ? (
                      <p className="py-4 text-center text-sm text-neutral-400">No campaigns synced for the selected client{selectedClientIds.size > 1 ? "s" : ""}.</p>
                    ) : (
                      campaignGroups.map((g) => (
                        <div key={g.key}>
                          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">{g.clientName}</div>
                          <div className="space-y-1">
                            {g.items.map((c) => (
                              <label key={c.id} className="flex items-center gap-2 text-sm text-neutral-800">
                                <Checkbox checked={selectedCampaigns.has(c.id)} onCheckedChange={() => toggleCampaign(c.id)} />
                                <span className="min-w-0 flex-1 truncate" title={c.name ?? c.bison_campaign_id}>{c.name ?? c.bison_campaign_id}</span>
                                {c.is_default && (
                                  <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">default</span>
                                )}
                              </label>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  {missingCount > 0 && !loadingCampaigns && (
                    <p className="mt-1 text-xs text-amber-600">
                      {missingCount} selected client{missingCount > 1 ? "s have" : " has"} no synced campaigns.
                    </p>
                  )}
                </div>
              )}
              <div>
                <label className="text-sm font-medium text-neutral-700">Data priority</label>
                <div className="mt-1.5 grid grid-cols-3 gap-2">
                  {([["courted", "MLS"], ["zillow", "Zillow"], ["realtor", "Realtor"]] as const).map(([s, lbl]) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSourcePriority(s)}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
                        sourcePriority === s ? "border-neutral-900 bg-brand text-white" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
                      )}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-neutral-500">
                  Which source’s values win for the lead fields — blanks fall back to the next source
                  ({sourcePriority === "courted" ? "MLS → Zillow → Realtor" : sourcePriority === "zillow" ? "Zillow → MLS → Realtor" : "Realtor → MLS → Zillow"}).
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-neutral-700">MLS data to send</label>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setMlsScopeSel([])}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs font-medium",
                      mlsScopeSel.length === 0 ? "border-brand bg-brand text-white" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
                    )}
                  >
                    All MLSs (combined)
                  </button>
                  {(mlsOpts ?? []).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      disabled={!m.ready}
                      title={m.ready ? undefined : "Available after this MLS's next data refresh"}
                      onClick={() => setMlsScopeSel((sel) => (sel.includes(m.id) ? sel.filter((x) => x !== m.id) : [...sel, m.id]))}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium",
                        !m.ready
                          ? "cursor-not-allowed border-neutral-200 text-neutral-300"
                          : mlsScopeSel.includes(m.id)
                          ? "border-brand bg-brand text-white"
                          : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
                      )}
                    >
                      {m.code ?? m.name}
                      {m.agents != null && <span className="ml-1 opacity-60">{m.agents.toLocaleString()}</span>}
                    </button>
                  ))}
                </div>
                {mlsOpts === null && <p className="mt-1 text-xs text-neutral-400">Checking which MLSs these agents belong to…</p>}
                {mlsOpts?.length === 0 && <p className="mt-1 text-xs text-neutral-400">These agents have no MLS affiliations.</p>}
                <p className="mt-1 text-xs text-neutral-500">
                  Only the MLSs these agents belong to, with how many of them are in each. Pick one or more to send just
                  those MLSs&apos; figures (summed); greyed-out MLSs unlock as their per-MLS data lands with the scraper refreshes.
                </p>
              </div>
              <p className="text-xs text-neutral-500">
                Each agent is enriched (email found + verified), then added to every selected campaign with all custom variables. A
                campaign is skipped for an agent only if they’re already in another campaign of that campaign’s client.
              </p>
            </>
          )}

          {/* portal options */}
          {method === "portal" && (
            <>
              <div>
                <label className="text-sm font-medium text-neutral-700">Client</label>
                <Select value={portalClient} onValueChange={setPortalClient}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder={portalClients.length ? "Select a client" : "Loading portals…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {portalClients.map((c) => (
                      <SelectItem key={c.name} value={c.name} disabled={!c.enabled}>
                        {c.name}
                        {!c.enabled && " (portal disabled)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {portalErr && <p className="mt-1 text-xs text-red-600">{portalErr}</p>}
              </div>
              <div>
                <label className="text-sm font-medium text-neutral-700">Add to</label>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  {([["agents", "Your Agents"], ["dnc", "DNC list"]] as const).map(([t, lbl]) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setPortalTarget(t)}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                        portalTarget === t ? "border-neutral-900 bg-brand text-white" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
                      )}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-neutral-500">
                {portalTarget === "agents"
                  ? "Adds the agents (name, email, phone, license) to the client's portal roster. Their emails are also blocklisted on the sending tools so the client's own agents are never cold-emailed."
                  : "Adds the agents to the client's Do-Not-Contact list. Entries with an email are blocklisted on Instantly and EmailBison immediately."}
                {" "}Re-sending the same agents is safe — the portal skips duplicates.
              </p>
            </>
          )}

          {/* columns — CSV only; campaign sends build their own variables */}
          {method === "csv" && (
            <div>
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-neutral-700">
                  Columns <span className="font-normal text-neutral-400">({cols.size}/{ALL_KEYS.length})</span>
                </label>
                <div className="flex gap-3 text-xs">
                  <button type="button" className="text-neutral-600 hover:underline" onClick={() => setCols(new Set(ALL_KEYS))}>
                    Select all
                  </button>
                  <button type="button" className="text-neutral-600 hover:underline" onClick={() => setCols(new Set())}>
                    Clear
                  </button>
                </div>
              </div>
              <div className="mt-1.5 grid max-h-48 grid-cols-2 gap-x-4 gap-y-1.5 overflow-auto rounded-lg border border-neutral-200 p-3">
                {EXPORT_COLUMNS.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 text-sm text-neutral-800">
                    <Checkbox checked={cols.has(c.key)} onCheckedChange={() => toggleCol(c.key)} />
                    <span className="truncate">{c.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* range */}
          <div>
            <label className="text-sm font-medium text-neutral-700">
              Range{" "}
              <span className="font-normal text-neutral-400">{hasSel ? "(ignored — rows are selected)" : "(blank = all filtered)"}</span>
            </label>
            <div className="mt-1 flex items-center gap-2">
              <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="From" inputMode="numeric" disabled={hasSel} />
              <span className="text-neutral-400">–</span>
              <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To" inputMode="numeric" disabled={hasSel} />
            </div>
          </div>

          <p className="text-xs text-neutral-500">
            {method === "csv" ? "Exporting" : "Sending"}: <span className="font-medium text-neutral-700">{scope}</span>
            {method === "csv" ? ` · ${cols.size} columns` : ""}
          </p>

          {/* A14b: the cap is real and was previously invisible — say so rather than claiming
              to send everything and quietly truncating. */}
          {isCapped && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Capped at {EXPORT_MAX_ROWS.toLocaleString()} per {method === "csv" ? "export" : "send"}. The remaining{" "}
              {(requested - EXPORT_MAX_ROWS).toLocaleString()} are not included — narrow the filters, or use the range
              boxes above to take the rest in a second batch.
            </p>
          )}

          {/* A14b: a six-figure campaign send costs real money per agent and drops leads into a
              live sending domain, so it has to be an explicit decision, not a stray click. */}
          {needsConfirm && (
            <label className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">
              <Checkbox checked={confirmedBig} onCheckedChange={() => setConfirmedBig((v) => !v)} className="mt-0.5" />
              <span>
                This will enrich and send <span className="font-semibold">{willSend.toLocaleString()} agents</span>. Each one
                is billed for email lookup and verification, and the leads go into a live campaign. Tick to confirm.
              </span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {method === "campaign" ? (
            // A14b: the button states the real number, and a large send stays disabled until
            // the confirmation above is ticked.
            <Button onClick={sendCampaign} disabled={busy || selectedCampaigns.size === 0 || (needsConfirm && !confirmedBig)}>
              {busy ? "Queueing…" : `Send ${willSend.toLocaleString()} to campaign${selectedCampaigns.size > 1 ? "s" : ""}`}
            </Button>
          ) : method === "portal" ? (
            <Button onClick={sendPortal} disabled={busy || !portalClient}>
              {busy ? "Sending…" : portalTarget === "agents" ? "Add to Your Agents" : "Add to DNC list"}
            </Button>
          ) : (
            <Button onClick={downloadCsv} disabled={busy}>
              {busy ? "Preparing…" : "Download CSV"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
