"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FileDown, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

// ---------- campaign sends (enrichment batches) ----------
interface BatchFilters {
  mode?: string;
  source?: string;
  selectedCount?: number;
  rangeFrom?: string | null;
  rangeTo?: string | null;
  filters?: Record<string, unknown>;
}
interface BatchRow {
  id: string;
  status: string;
  campaign_name: string | null;
  client_name: string | null;
  performed_by: string | null;
  total: number;
  enriched: number;
  no_email: number;
  sent: number;
  failed: number;
  skipped: number;
  created_at: string;
  finished_at: string | null;
  filters: BatchFilters | null;
}
interface AuditRow {
  id: string;
  action: string;
  performed_by: string | null;
  details: string | null;
  created_at: string;
}
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");

const BATCH_TONE: Record<string, string> = {
  queued: "bg-neutral-100 text-neutral-700",
  running: "bg-blue-100 text-blue-800",
  done: "bg-green-100 text-green-800",
  cancelled: "bg-neutral-100 text-neutral-500",
};

// Compact human summary of the search selection a batch was created from.
function summarizeFilters(bf: BatchFilters | null): string {
  if (!bf) return "—";
  const parts: string[] = [];
  const f = (bf.filters ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if ((bf.selectedCount ?? 0) > 0) parts.push(`${bf.selectedCount} hand-picked`);
  // Client filter: new multi-select shape (orchClientIds) or the legacy scalar (old batches).
  const clientIdCount = Array.isArray(f.orchClientIds) ? f.orchClientIds.length : f.orchClientId ? 1 : 0;
  if (clientIdCount > 0) parts.push(`Client filter (${f.orchClientMode === "exclude" ? "exclude " : ""}${clientIdCount})`);
  if (f.contact?.email) parts.push(f.contact.email === "has" ? "Has email" : "No email");
  if (f.contact?.phone) parts.push(f.contact.phone === "has" ? "Has phone" : "No phone");
  if (f.multiMls) parts.push("Multi-MLS only");
  if (f.multiCampaign) parts.push("In multiple campaigns");
  const sv = f.savedViews as { include?: string[]; exclude?: string[] } | undefined;
  if (sv?.include?.length) parts.push(`${sv.include.length} view${sv.include.length > 1 ? "s" : ""} incl`);
  if (sv?.exclude?.length) parts.push(`${sv.exclude.length} view${sv.exclude.length > 1 ? "s" : ""} excl`);
  if (f.location?.values?.length) {
    const v = f.location.values;
    parts.push(`${f.location.field ?? "city"}: ${v.slice(0, 2).join(", ")}${v.length > 2 ? ` +${v.length - 2}` : ""}`);
  }
  const range = (label: string, r?: { buckets?: string[]; min?: string; max?: string; side?: string }) => {
    if (!r) return;
    const bits = [...(r.buckets ?? [])];
    if (r.min || r.max) bits.push(`${r.min || "0"}–${r.max || "∞"}`);
    if (bits.length) parts.push(`${label}${r.side && r.side !== "all" ? ` (${r.side})` : ""}: ${bits.join(", ")}`);
  };
  range("Sales volume", f.salesVolume);
  range("Closed units", f.closedUnits);
  range("Closed transactions", f.closedTransactions);
  range("Time in industry", f.estTimeInIndustry);
  range("GCI", f.approxGci);
  range("Avg sale price", f.avgSalePrice);
  range("Time at office", f.estTimeInOffice);
  range("Avg time at office", f.avgTimeAtOffice);
  const ie = (label: string, x?: { include?: string[]; exclude?: string[] }) => {
    if (!x) return;
    if (x.include?.length) parts.push(`${label}: ${x.include.length} incl`);
    if (x.exclude?.length) parts.push(`${label}: ${x.exclude.length} excl`);
  };
  ie("Brand", f.officeSearch?.brand);
  ie("Office", f.officeSearch?.office);
  ie("MLS", f.mls);
  ie("Title", f.title);
  ie("License", f.license);
  ie("Name", f.name);
  if (f.nameQuery) parts.push(`find “${f.nameQuery}”`);
  if (bf.mode === "office") parts.push("Office mode");
  if (bf.source && bf.source !== "all") parts.push(bf.source === "courted" ? "MLS" : "Zillow/Realtor");
  if (bf.rangeFrom || bf.rangeTo) parts.push(`rows ${bf.rangeFrom ?? 1}–${bf.rangeTo ?? "end"}`);
  return parts.length ? parts.join(" · ") : "no filters (all agents)";
}

interface FailureRow {
  full_name: string | null;
  email: string | null;
  attempts: number;
  reasons: string[];
}

// ---------- batch drill-down: Clay-style enrichment grid ----------
interface StepEntry {
  step: string;
  ok: boolean;
  ms?: number;
  note?: string | null;
}
interface ItemRow {
  id: string;
  full_name: string | null;
  email: string | null;
  email_status: string | null;
  provider: string | null;
  status: string;
  error: string | null;
  attempts: number;
  step_log: StepEntry[] | null;
}

const ITEM_TONE: Record<string, string> = {
  sent: "bg-green-100 text-green-800",
  enriched: "bg-green-100 text-green-800",
  skipped: "bg-amber-100 text-amber-800",
  no_email: "bg-neutral-100 text-neutral-600",
  failed: "bg-red-100 text-red-700",
  pending: "bg-neutral-100 text-neutral-500",
  enriching: "bg-blue-100 text-blue-800",
  pushing: "bg-blue-100 text-blue-800",
};
const STEP_LABEL: Record<string, string> = {
  // v2 pipeline (Sep 2026)
  verify_preferred_mv: "Verify existing email",
  db_domain: "Office domain (from DB)",
  verify_work_mv: "Verify work email",
  verify_personal_courted: "Verify Courted personal",
  verify_professional_courted: "Verify Courted work",
  find_linkedin: "Find LinkedIn",
  be_personal: "Personal email",
  verify_personal: "Verify personal",
  verify_personal_be: "Verify found email",
  find_domain: "Find domain",
  be_work: "Work email",
  verify_work: "Verify work",
  verify_work_be: "Verify found work email",
  cache: "Cached result",
  client_dedup: "Client dedup",
};

// Clay-style grid: one row per lead; columns are the pipeline steps that actually ran in
// THIS batch (union, in first-seen order), each cell the step's verdict + result note.
function BatchLeadsDialog({ batch, onClose }: { batch: BatchRow; onClose: () => void }) {
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/enrichment/items?batchId=${batch.id}`)
      .then((r) => r.json())
      .then((j) => active && setItems(j.items ?? []))
      .catch(() => active && setItems([]));
    return () => {
      active = false;
    };
  }, [batch.id]);

  const stepCols = useMemo(() => {
    const seen: string[] = [];
    for (const it of items ?? [])
      for (const s of it.step_log ?? [])
        if (s?.step && !seen.includes(s.step)) seen.push(s.step);
    return seen;
  }, [items]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter(
      (it) =>
        (!statusFilter || it.status === statusFilter) &&
        (!needle ||
          (it.full_name ?? "").toLowerCase().includes(needle) ||
          (it.email ?? "").toLowerCase().includes(needle))
    );
  }, [items, q, statusFilter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const it of items ?? []) c[it.status] = (c[it.status] ?? 0) + 1;
    return c;
  }, [items]);

  const CAP = 1000;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-[95vw]">
        <DialogHeader>
          <DialogTitle className="pr-8">
            Enrichment — {batch.campaign_name ?? "(enrich only)"}
            <span className="ml-2 text-sm font-normal text-neutral-500">
              {fmt(batch.created_at)} · {batch.total.toLocaleString()} leads
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or email"
            className="h-8 w-64 rounded-lg border border-neutral-300 px-3 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setStatusFilter(null)}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ${!statusFilter ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
          >
            All {items ? `(${items.length})` : ""}
          </button>
          {Object.entries(counts).map(([s, n]) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusFilter === s ? "bg-neutral-900 text-white" : (ITEM_TONE[s] ?? "bg-neutral-100 text-neutral-600") + " hover:opacity-80"}`}
            >
              {s.replace("_", " ")} ({n})
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-neutral-200">
          {!items ? (
            <p className="py-12 text-center text-sm text-neutral-400">Loading enrichment details…</p>
          ) : shown.length === 0 ? (
            <p className="py-12 text-center text-sm text-neutral-400">No leads match.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-neutral-50 text-left text-xs font-medium text-neutral-500">
                <tr>
                  <th className="whitespace-nowrap px-3 py-2">Lead</th>
                  <th className="whitespace-nowrap px-3 py-2">Email found</th>
                  <th className="whitespace-nowrap px-3 py-2">Verification</th>
                  <th className="whitespace-nowrap px-3 py-2">Outcome</th>
                  {stepCols.map((s) => (
                    <th key={s} className="whitespace-nowrap px-3 py-2">
                      {STEP_LABEL[s] ?? s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, CAP).map((it) => {
                  const bySteps = new Map((it.step_log ?? []).map((s) => [s.step, s]));
                  return (
                    <tr key={it.id} className="border-t border-neutral-100 align-top hover:bg-neutral-50/60">
                      <td className="whitespace-nowrap px-3 py-2 font-medium text-neutral-900">{it.full_name ?? "Unknown"}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-neutral-700">{it.email ?? <span className="text-neutral-400">—</span>}</td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {it.email_status ? (
                          <span className="text-neutral-800">{it.email_status}</span>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                        {it.provider && <div className="text-[11px] text-neutral-400">{it.provider.replace(/_/g, " ")}</div>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <Badge className={ITEM_TONE[it.status] ?? "bg-neutral-100 text-neutral-700"}>{it.status.replace("_", " ")}</Badge>
                        {it.error && (
                          <div className="max-w-56 truncate text-[11px] text-red-600" title={it.error}>
                            {it.error}
                          </div>
                        )}
                      </td>
                      {stepCols.map((s) => {
                        const e = bySteps.get(s);
                        if (!e)
                          return (
                            <td key={s} className="whitespace-nowrap px-3 py-2 text-neutral-300">
                              —
                            </td>
                          );
                        return (
                          <td
                            key={s}
                            className="max-w-52 truncate whitespace-nowrap px-3 py-2 text-xs"
                            title={`${e.ok ? "ok" : "failed"}${e.ms != null ? ` · ${(e.ms / 1000).toFixed(1)}s` : ""}${e.note ? ` · ${e.note}` : ""}`}
                          >
                            <span className={e.ok ? "text-green-600" : "text-red-600"}>{e.ok ? "✓" : "✗"}</span>
                            {e.note && <span className="ml-1 text-neutral-500">{e.note}</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {items && shown.length > CAP && (
          <p className="text-xs text-neutral-400">
            Showing first {CAP.toLocaleString()} of {shown.length.toLocaleString()} — use search or the status chips to narrow.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function ExportPage() {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, FailureRow[] | "loading">>({});
  const [openBatch, setOpenBatch] = useState<BatchRow | null>(null); // Clay-style drill-down

  const load = useCallback(async () => {
    const [b, h] = await Promise.all([fetch("/api/enrichment/batches"), fetch("/api/export/history")]);
    const bj = await b.json().catch(() => ({}));
    const hj = await h.json().catch(() => ({}));
    setBatches(bj.batches ?? []);
    setRows(hj.rows ?? []);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // live progress while batches run
    return () => clearInterval(t);
  }, [load]);

  async function toggleFailures(batchId: string) {
    if (expanded === batchId) {
      setExpanded(null);
      return;
    }
    setExpanded(batchId);
    setFailures((f) => ({ ...f, [batchId]: "loading" }));
    const r = await fetch(`/api/enrichment/failures?batchId=${batchId}`);
    const j = await r.json().catch(() => ({}));
    setFailures((f) => ({ ...f, [batchId]: j.failures ?? [] }));
  }

  async function retryBatch(b: BatchRow) {
    if (!confirm(`Re-queue the ${b.failed} failed agent${b.failed > 1 ? "s" : ""}? Sent and skipped agents are never re-sent.`)) return;
    setRetrying(b.id);
    try {
      const res = await fetch("/api/enrichment/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: b.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(j.error ?? "Retry failed");
      else toast.success(`Re-queued ${j.retried} agent${j.retried === 1 ? "" : "s"} — the worker is on it`);
    } finally {
      setRetrying(null);
      setExpanded(null);
      load();
    }
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Export</h1>
        <p className="mt-0.5 text-sm text-neutral-500">Campaign sends (enrich → EmailBison) and CSV downloads from Agent Search.</p>
      </div>

      <Link href="/search" className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-white p-4 text-sm shadow-sm hover:bg-neutral-50">
        <Users className="h-5 w-5 text-neutral-400" />
        <div>
          <div className="font-medium text-neutral-800">Export from Agent Search</div>
          <div className="text-neutral-500">Filter agents (use the Client filter for a client&apos;s reviewed leads), then Export → Send to campaign or Download CSV.</div>
        </div>
      </Link>

      {/* Campaign sends */}
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <div className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold text-neutral-900">Campaign sends</div>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-medium text-neutral-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">By</th>
                <th className="px-4 py-2">Client</th>
                <th className="px-4 py-2">Campaign</th>
                <th className="px-4 py-2">Filters used</th>
                <th className="px-4 py-2">Uploaded to Bison</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {batches.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-neutral-400">
                    <FileDown className="mx-auto mb-2 h-6 w-6 text-neutral-300" />
                    No campaign sends yet.
                  </td>
                </tr>
              ) : (
                batches.flatMap((b) => {
                  const pending = b.total - b.sent - b.skipped - b.no_email - b.failed;
                  const fl = failures[b.id];
                  const out = [
                    <tr
                      key={b.id}
                      onClick={() => setOpenBatch(b)}
                      title="View per-lead enrichment"
                      className="cursor-pointer border-t border-neutral-100 align-top hover:bg-neutral-50"
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 text-neutral-500">{fmt(b.created_at)}</td>
                      <td className="px-4 py-2.5 text-neutral-600">{b.performed_by ?? "—"}</td>
                      <td className="px-4 py-2.5 text-neutral-800">{b.client_name ?? "—"}</td>
                      <td className="max-w-52 truncate px-4 py-2.5 text-neutral-600" title={b.campaign_name ?? undefined}>
                        {b.campaign_name ?? "(enrich only)"}
                      </td>
                      <td className="max-w-64 px-4 py-2.5 text-xs text-neutral-500" title={summarizeFilters(b.filters)}>
                        <span className="line-clamp-2">{summarizeFilters(b.filters)}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span className="font-semibold text-green-700">{b.sent}</span>
                        <span className="text-neutral-400"> of {b.total}</span>
                        <div className="text-xs text-neutral-500">
                          {b.skipped > 0 && <span>{b.skipped} already in client’s campaigns · </span>}
                          {b.no_email > 0 && <span>{b.no_email} no email found · </span>}
                          {b.failed > 0 && (
                            <button type="button" onClick={(e) => { e.stopPropagation(); toggleFailures(b.id); }} className="text-red-600 underline decoration-dotted hover:text-red-800">
                              {b.failed} failed {expanded === b.id ? "▴" : "▾"}
                            </button>
                          )}
                          {b.failed > 0 && " · "}
                          {pending > 0 && <span>{pending} in progress</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge className={BATCH_TONE[b.status] ?? "bg-neutral-100 text-neutral-700"}>{b.status}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {b.failed > 0 && b.status === "done" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 shrink-0 whitespace-nowrap px-2 text-xs"
                            disabled={retrying === b.id}
                            onClick={(e) => { e.stopPropagation(); retryBatch(b); }}
                          >
                            {retrying === b.id ? "Retrying…" : `Retry failed (${b.failed})`}
                          </Button>
                        )}
                      </td>
                    </tr>,
                  ];
                  if (expanded === b.id) {
                    out.push(
                      <tr key={b.id + "-failures"} className="border-t border-neutral-100 bg-red-50/40">
                        <td colSpan={8} className="px-6 py-3">
                          {fl === "loading" || !fl ? (
                            <span className="text-sm text-neutral-400">Loading failure details…</span>
                          ) : fl.length === 0 ? (
                            <span className="text-sm text-neutral-400">No failed agents (they may have been retried already).</span>
                          ) : (
                            <div className="space-y-1.5">
                              {fl.map((f, i) => (
                                <div key={i} className="text-xs">
                                  <span className="font-medium text-neutral-800">{f.full_name ?? "Unknown agent"}</span>
                                  {f.email && <span className="text-neutral-500"> · {f.email}</span>}
                                  <span className="text-neutral-400"> · {f.attempts} attempts</span>
                                  <div className="text-red-700">{f.reasons.join(" — ")}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  }
                  return out;
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {openBatch && <BatchLeadsDialog batch={openBatch} onClose={() => setOpenBatch(null)} />}

      {/* CSV + legacy history */}
      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
        <div className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold text-neutral-900">CSV downloads &amp; legacy Clay sends</div>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs font-medium text-neutral-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">By</th>
                <th className="px-4 py-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-neutral-400">No CSV exports yet.</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-100">
                    <td className="whitespace-nowrap px-4 py-2 text-neutral-500">{fmt(r.created_at)}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs ${r.action === "clay_send" ? "bg-purple-100 text-purple-800" : "bg-blue-100 text-blue-800"}`}>
                        {r.action === "clay_send" ? "Clay (legacy)" : "CSV"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-neutral-600">{r.performed_by ?? "—"}</td>
                    <td className="px-4 py-2 text-neutral-600">{r.details ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
