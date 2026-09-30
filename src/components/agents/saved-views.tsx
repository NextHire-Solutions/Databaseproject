"use client";

import { useEffect, useState } from "react";
import { Save, Trash2, FolderOpen, Pencil, Check, X, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { Filters } from "@/types/agent-filters";
import { activeFilterCount } from "@/types/agent-filters";

interface SavedList {
  id: string;
  name: string;
  filters: Filters;
  cached_count?: number | null; // B4: cached agent count, refreshed on save/edit/import/6h sync
  orch_client_id?: string | null; // 0125: the client this view belongs to (optional)
  client_name?: string | null;
}

interface ClientOpt {
  id: string;
  client_name: string | null;
}

// Compact client picker for the save/edit rows. The option list is whatever /api/orch/clients
// returns for THIS caller — a client-restricted account is only ever offered its own clients,
// and the server re-checks on save either way.
function ClientSelect({ value, onChange, clients }: { value: string; onChange: (v: string) => void; clients: ClientOpt[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-lg border border-neutral-300 bg-white px-2 text-sm text-neutral-700 focus:border-neutral-400 focus:outline-none"
    >
      <option value="">No client</option>
      {clients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.client_name}
        </option>
      ))}
    </select>
  );
}

export function SavedViews({
  filters,
  onLoad,
  selected,
  onSelect,
}: {
  filters: Filters;
  onLoad: (f: Filters) => void;
  // The live "Saved views" FILTER selection (savedViews.include). The tick beside each name
  // toggles membership of that filter — i.e. exactly what picking the view in the Saved views
  // filter popover does — as opposed to the name itself, which still LOADS the view's filters
  // into the search. Two different actions, so they get two different controls.
  selected?: string[];
  onSelect?: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<SavedList[]>([]);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [q, setQ] = useState(""); // filter the list by name or client
  const [clientId, setClientId] = useState(""); // 0125: client for the view being saved
  const [editClientId, setEditClientId] = useState("");
  const [clients, setClients] = useState<ClientOpt[]>([]);

  async function load() {
    const r = await fetch("/api/lists");
    const j = await r.json();
    setLists(j.lists ?? []);
  }
  useEffect(() => {
    if (open) {
      load();
      if (clients.length === 0) {
        fetch("/api/orch/clients")
          .then((r) => r.json())
          .then((j) => setClients(((j.clients ?? []) as ClientOpt[]).filter((c) => c.client_name)))
          .catch(() => {}); // no client access -> picker simply offers "No client"
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A view saved with nothing applied matches the whole database, so every search that later
  // references it scans 1.1M rows. That happened in production, so saving one now takes a
  // deliberate second click rather than going through silently.
  const emptyFilters = activeFilterCount(filters, "agent") === 0;
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  async function save() {
    if (!name.trim()) {
      toast.error("Name this view");
      return;
    }
    if (emptyFilters && !confirmEmpty) {
      setConfirmEmpty(true);
      toast.warning("No filters are applied — this view would match every agent. Click Save again to confirm.");
      return;
    }
    setConfirmEmpty(false);
    setSaving(true);
    const res = await fetch("/api/lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, filters, orchClientId: clientId || null }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success("View saved");
      setName("");
      setClientId("");
      load();
    } else {
      const j = await res.json().catch(() => ({}));
      toast.error(j.error ?? "Save failed");
    }
  }

  async function del(id: string) {
    const res = await fetch(`/api/lists/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  async function update(id: string) {
    if (activeFilterCount(filters, "agent") === 0 && !window.confirm("No filters are applied. Updating this view will make it match every agent. Continue?")) {
      return;
    }
    const res = await fetch(`/api/lists/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters }),
    });
    if (res.ok) {
      toast.success("View updated with current filters");
      load();
    } else {
      toast.error("Update failed");
    }
  }

  async function rename(id: string) {
    if (!editName.trim()) return;
    const res = await fetch(`/api/lists/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editName.trim(), orchClientId: editClientId || null }),
    });
    setEditId(null);
    if (res.ok) {
      toast.success("View updated");
      load();
    } else {
      toast.error("Rename failed");
    }
  }

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? lists.filter(
        (v) => v.name.toLowerCase().includes(needle) || (v.client_name ?? "").toLowerCase().includes(needle)
      )
    : lists;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" title="Save / load views" className="rounded-md bg-neutral-100 p-2 text-neutral-500 hover:bg-neutral-200">
          <Save className="h-[18px] w-[18px]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-2xl p-3 shadow-xl">
        <div className="text-sm font-medium text-neutral-800">Save current filters</div>
        <div className="mt-2 flex gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this view…"
            className="h-9"
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <Button onClick={save} disabled={saving} size="sm" className="h-9">
            Save
          </Button>
        </div>
        {clients.length > 0 && (
          <div className="mt-1.5">
            <ClientSelect value={clientId} onChange={setClientId} clients={clients} />
          </div>
        )}
        <div className="mb-1 mt-3 text-xs font-medium text-neutral-500">Saved views</div>
        {lists.length > 5 && (
          <div className="relative mb-1.5">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search views…"
              className="h-8 w-full rounded-lg border border-neutral-300 pl-8 pr-2 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
            />
          </div>
        )}
        <div className="max-h-56 space-y-0.5 overflow-auto">
          {shown.length === 0 ? (
            <div className="px-1 py-2 text-sm text-neutral-400">
              {lists.length === 0 ? "No saved views yet." : "No views match."}
            </div>
          ) : (
            shown.map((v) =>
              editId === v.id ? (
                <div key={v.id} className="space-y-1.5 rounded px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                      className="h-8"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") rename(v.id);
                        if (e.key === "Escape") setEditId(null);
                      }}
                    />
                    <button type="button" onClick={() => rename(v.id)} className="text-neutral-500 hover:text-green-600" title="Save changes">
                      <Check className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => setEditId(null)} className="text-neutral-400 hover:text-neutral-700" title="Cancel">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {clients.length > 0 && <ClientSelect value={editClientId} onChange={setEditClientId} clients={clients} />}
                </div>
              ) : (
                <div key={v.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-neutral-50">
                  {onSelect && (
                    <button
                      type="button"
                      onClick={() => {
                        const cur = selected ?? [];
                        const next = cur.includes(v.id) ? cur.filter((x) => x !== v.id) : [...cur, v.id];
                        onSelect(next);
                        toast.success(
                          next.includes(v.id) ? `Filtering by "${v.name}"` : `Removed "${v.name}" from the filter`
                        );
                      }}
                      title={
                        (selected ?? []).includes(v.id)
                          ? "Remove this view from the Saved views filter"
                          : "Filter the search by this view (same as picking it in the Saved views filter)"
                      }
                      className="mr-1.5 shrink-0 text-neutral-400 hover:text-brand"
                      aria-pressed={(selected ?? []).includes(v.id)}
                    >
                      {(selected ?? []).includes(v.id) ? (
                        <span className="flex h-4 w-4 items-center justify-center rounded border border-brand bg-brand text-white">
                          <Check className="h-3 w-3" />
                        </span>
                      ) : (
                        <span className="block h-4 w-4 rounded border border-neutral-300" />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onLoad(v.filters);
                      setOpen(false);
                      toast.success(`Loaded "${v.name}"`);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-neutral-800"
                  >
                    <FolderOpen className="h-4 w-4 shrink-0 text-neutral-400" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{v.name}</span>
                          {v.client_name && (
                            <span className="block truncate text-[11px] leading-tight text-neutral-400">{v.client_name}</span>
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs break-words">
                        {v.name}
                        {v.client_name ? ` — ${v.client_name}` : ""}
                      </TooltipContent>
                    </Tooltip>
                  </button>
                  {/* Count is its OWN column, not part of the name button: inside the button it
                      sat immediately after the name, so a short name pulled it left and a long
                      one pushed it right — the rows looked ragged. Fixed width + right alignment
                      keeps every count in the same place regardless of name length. */}
                  <span className="w-12 shrink-0 text-right text-xs tabular-nums text-neutral-400">
                    {v.cached_count != null ? v.cached_count.toLocaleString() : ""}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditId(v.id);
                        setEditName(v.name);
                        setEditClientId(v.orch_client_id ?? "");
                      }}
                      className="text-neutral-300 hover:text-neutral-700"
                      title="Rename view"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => update(v.id)} title="Save current filters into this view" className="text-xs font-medium text-neutral-500 hover:text-neutral-900">
                      Update
                    </button>
                    <button type="button" onClick={() => del(v.id)} className="text-neutral-300 hover:text-red-600" title="Delete view">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )
            )
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
