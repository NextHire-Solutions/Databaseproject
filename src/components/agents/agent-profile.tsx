"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// A5: agent profile — identity, combined production, then one section per MLS with that
// MLS's own numbers. Per-MLS figures fill in as the 15-day refresh cycles land; until an
// MLS re-scrapes, its section shows membership with a "not yet captured" placeholder.

interface MlsRow {
  code: string | null;
  name: string | null;
  mls_member_id: string | null;
  mls_refreshed: string | null;
  sales_volume: string | null;
  pct_change: string | null;
  buy_side_dollar: string | null;
  list_side_dollar: string | null;
  approx_gci: string | null;
  avg_sale_price: string | null;
  closed_transactions: string | null;
  units: string | null;
  buy_side_count: string | null;
  list_side_count: string | null;
  closed_rentals: string | null;
  avg_rental_price: string | null;
  stats_as_of: string | null;
}
interface Profile {
  agent: Record<string, string | number | null> & {
    full_name: string | null;
    agent_provided?: { email?: string; phone?: string; added_by?: string; added_at?: string } | null;
    manual_titles?: string[] | null; // A5: hand-applied role tags
  };
  mls: MlsRow[];
  sources: { source: string; sales_volume: string | null; units: string | null; scraped: string | null }[];
}

const usd = (v: string | number | null | undefined) =>
  v == null || v === "" ? "—" : "$" + Math.round(Number(v)).toLocaleString();
const num = (v: string | number | null | undefined) => (v == null || v === "" ? "—" : Number(v).toLocaleString());

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-neutral-500">{label}</div>
      <div className="truncate text-sm font-medium tabular-nums text-neutral-900">{value}</div>
    </div>
  );
}

function StatGrid({ s }: { s: { [k: string]: string | number | null | undefined } | MlsRow }) {
  const g = s as { [k: string]: string | number | null | undefined };
  return <StatGridInner s={g} />;
}

function StatGridInner({ s }: { s: { [k: string]: string | number | null | undefined } }) {
  return (
    <div className="grid grid-cols-4 gap-x-4 gap-y-2">
      <Stat label="Sales volume" value={usd(s.sales_volume)} />
      <Stat label="Buy-side ($)" value={usd(s.buy_side_dollar)} />
      <Stat label="List-side ($)" value={usd(s.list_side_dollar)} />
      <Stat label="Est. GCI" value={usd(s.approx_gci)} />
      <Stat label="Avg sale price" value={usd(s.avg_sale_price)} />
      <Stat label="Closed transactions" value={num(s.closed_transactions)} />
      <Stat label="Units" value={num(s.units)} />
      <Stat label="Rentals" value={num(s.closed_rentals)} />
    </div>
  );
}

export function AgentProfileDialog({ agentId, onClose }: { agentId: string | null; onClose: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!agentId) return;
    setProfile(null);
    setError(null);
    setEditOpen(false);
    setNewEmail("");
    setNewPhone("");
    let active = true;
    fetch(`/api/agents/profile?id=${agentId}`)
      .then((r) => r.json())
      .then((j) => {
        if (!active) return;
        if (j.error) setError(j.error);
        else setProfile(j as Profile);
      })
      .catch(() => active && setError("Failed to load profile"));
    return () => {
      active = false;
    };
  }, [agentId, reloadKey]);

  const [tagging, setTagging] = useState(false);

  async function saveProvided() {
    if (saving) return;
    setSaving(true);
    const res = await fetch("/api/agents/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, email: newEmail, phone: newPhone }),
    });
    const j = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      toast.error(j.error ?? "Failed to save");
      return;
    }
    toast.success(newEmail.trim() || newPhone.trim() ? "Contact info saved — campaign sends will prefer it" : "Agent-provided contact removed");
    setEditOpen(false);
    setReloadKey((k) => k + 1);
  }

  // A5: tag a role by hand. Stored apart from the derived title so the next data sweep cannot
  // erase it; the server returns the recomputed effective title.
  const ROLES = ["Managing Broker", "Team Leader"] as const;
  async function toggleRole(role: string) {
    if (tagging) return;
    const cur = profile?.agent?.manual_titles ?? [];
    const next = cur.includes(role) ? cur.filter((r) => r !== role) : [...cur, role];
    setTagging(true);
    const res = await fetch("/api/agents/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: agentId, titles: next }),
    });
    const j = await res.json().catch(() => ({}));
    setTagging(false);
    if (!res.ok) {
      toast.error(j.error ?? "Failed to save tag");
      return;
    }
    toast.success(next.length ? `Tagged as ${next.join(", ")}` : "Role tags cleared");
    setReloadKey((k) => k + 1);
  }

  const a = profile?.agent;
  const multi = (profile?.mls.length ?? 0) > 1;
  return (
    <Dialog open={!!agentId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{a?.full_name ?? "Agent profile"}</DialogTitle>
        </DialogHeader>
        {error ? (
          <p className="py-8 text-center text-sm text-red-600">{error}</p>
        ) : !profile || !a ? (
          <p className="py-8 text-center text-sm text-neutral-400">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <div className="text-neutral-600">
                {String(a.title ?? "")}
                {a.license_number ? ` · License #${a.license_number}` : ""}
                {/* A5: role tags. Checked = tagged by hand here; a role that came from the data
                    feed shows in the title above but leaves these unchecked, so it is always
                    clear which roles a person asserted vs which the feed supplied. */}
                <div className="mt-1 flex items-center gap-3">
                  {ROLES.map((r) => {
                    const on = (a.manual_titles ?? []).includes(r);
                    return (
                      <label key={r} className="flex items-center gap-1.5 text-xs text-neutral-500">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={tagging}
                          onChange={() => toggleRole(r)}
                          className="h-3.5 w-3.5 rounded border-neutral-300"
                        />
                        Tag as {r}
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="truncate text-neutral-600">{[a.brand, a.office_name].filter(Boolean).join(" — ") || "No office on file"}</div>
              <div className="truncate text-neutral-600">
                {a.preferred_email ? String(a.preferred_email) : "No source email"}
                {a.enriched_email && a.enriched_email !== a.preferred_email && (
                  <span className="block truncate text-xs text-neutral-400">enriched: {String(a.enriched_email)}</span>
                )}
              </div>
              <div className="text-neutral-600">{String(a.preferred_phone ?? "No phone")}</div>
            </div>

            {/* C3: contact info the agent provided directly — never overwrites, always wins on sends */}
            <div className="rounded-xl border border-neutral-200 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-neutral-900">Provided by agent</span>
                <button
                  type="button"
                  className="text-xs text-blue-700 hover:underline"
                  onClick={() => {
                    if (!editOpen) {
                      setNewEmail(a?.agent_provided?.email ?? "");
                      setNewPhone(a?.agent_provided?.phone ?? "");
                    }
                    setEditOpen((v) => !v);
                  }}
                >
                  {editOpen ? "Cancel" : a?.agent_provided?.email || a?.agent_provided?.phone ? "Edit / remove" : "Add contact info"}
                </button>
              </div>
              {a.agent_provided?.email || a.agent_provided?.phone ? (
                <div className="mt-1 text-sm text-neutral-700">
                  {a.agent_provided.email && <div className="truncate">{a.agent_provided.email}</div>}
                  {a.agent_provided.phone && <div>{a.agent_provided.phone}</div>}
                  <div className="mt-0.5 text-[11px] text-neutral-400">
                    added {a.agent_provided.added_at ? new Date(a.agent_provided.added_at).toLocaleDateString() : ""}
                    {a.agent_provided.added_by ? ` by ${a.agent_provided.added_by}` : ""} · campaign sends prefer these
                  </div>
                </div>
              ) : (
                !editOpen && <p className="mt-1 text-xs text-neutral-400">None yet — add an email/phone the agent gave you (existing values are kept).</p>
              )}
              {editOpen && (
                <div className="mt-2 space-y-2">
                  <Input placeholder="Email (clear to remove)" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
                  <Input placeholder="Phone (clear to remove)" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-neutral-400">Saving replaces both fields; clearing both removes the entry.</span>
                    <Button size="sm" onClick={saveProvided} disabled={saving}>
                      {saving ? "Saving…" : "Save"}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-neutral-200 p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-sm font-semibold text-neutral-900">Production {multi ? "(combined)" : ""}</span>
                <span className="text-[11px] text-neutral-400">
                  {multi ? "one arbitrary MLS's figures until per-MLS data completes — see below" : ""}
                </span>
              </div>
              <StatGrid s={a} />
            </div>

            <div>
              <div className="mb-1 text-sm font-semibold text-neutral-900">
                MLS affiliations ({profile.mls.length})
              </div>
              <div className="space-y-2">
                {profile.mls.length === 0 && <p className="text-sm text-neutral-400">No MLS memberships on file.</p>}
                {profile.mls.map((m) => (
                  <div key={m.code ?? Math.random()} className="rounded-xl border border-neutral-200 p-3">
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium text-neutral-900">
                        {m.name ?? m.code}
                        {m.code && m.name && m.name !== m.code && <span className="text-neutral-400"> ({m.code})</span>}
                      </span>
                      <span className="shrink-0 text-[11px] text-neutral-400">
                        {m.mls_member_id ? `Member ID ${m.mls_member_id}` : ""}
                        {m.mls_refreshed ? ` · MLS refreshed ${m.mls_refreshed}` : ""}
                      </span>
                    </div>
                    {m.stats_as_of ? (
                      <StatGrid s={m} />
                    ) : (
                      <p className="text-xs text-neutral-400">
                        Per-MLS numbers not captured yet — they arrive with this MLS&apos;s next data refresh.
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {profile.sources.length > 1 && (
              <p className="text-[11px] text-neutral-400">
                Sources: {profile.sources.map((s) => `${s.source} (${s.scraped ?? "?"})`).join(" · ")}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
