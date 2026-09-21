"use client";

import { useEffect, useState } from "react";
import { Save, Trash2, FolderOpen, Pencil, Check, X, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { Filters } from "@/types/agent-filters";
import { activeFilterCount } from "@/types/agent-filters";

interface SavedList {
  id: string;
  name: string;
  filters: Filters;
  cached_count?: number | null; // B4: cached agent count, refreshed on save/edit/import/6h sync
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
  const [q, setQ] = useState(""); // filter the list by name

  async function load() {
    const r = await fetch("/api/lists");
    const j = await r.json();
    setLists(j.lists ?? []);
  }
  useEffect(() => {
    if (open) load();
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
      body: JSON.stringify({ name, filters }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success("View saved");
      setName("");
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
      body: JSON.stringify({ name: editName.trim() }),
    });
    setEditId(null);
    if (res.ok) {
      toast.success("View renamed");
      load();
    } else {
      toast.error("Rename failed");
    }
  }

  const needle = q.trim().toLowerCase();
  const shown = needle ? lists.filter((v) => v.name.toLowerCase().includes(needle)) : lists;

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
                <div key={v.id} className="flex items-center gap-2 rounded px-2 py-1.5">
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
                  <button type="button" onClick={() => rename(v.id)} className="text-neutral-500 hover:text-green-600" title="Save name">
                    <Check className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => setEditId(null)} className="text-neutral-400 hover:text-neutral-700" title="Cancel">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div key={v.id} className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-neutral-50">
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
                    className="flex min-w-0 items-center gap-2 text-left text-sm text-neutral-800"
                  >
                    <FolderOpen className="h-4 w-4 shrink-0 text-neutral-400" />
                    <span className="truncate">{v.name}</span>
                    {v.cached_count != null && (
                      <span className="shrink-0 text-xs tabular-nums text-neutral-400">{v.cached_count.toLocaleString()}</span>
                    )}
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditId(v.id);
                        setEditName(v.name);
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
