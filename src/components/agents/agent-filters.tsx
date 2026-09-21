"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { Bucket, IncludeExclude, VolumeSide } from "@/types/agent-filters";
import { TITLES } from "@/types/agent-filters";

const SIDES: [VolumeSide, string][] = [
  ["all", "All"],
  ["list", "List-side"],
  ["buy", "Buy-side"],
];

// ---------- shared popover chrome (Courted-style trigger + panel + Clear/Apply) ----------
export function FilterPopoverShell({
  label,
  count,
  open,
  onOpenChange,
  onClear,
  onApply,
  width = "w-[420px]",
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onClear: () => void;
  onApply: () => void;
  width?: string;
  children: React.ReactNode;
}) {
  // A7: dismissing by clicking away COMMITS the draft instead of discarding it — losing a long
  // selection to a stray click was the reported problem. Escape stays the discard gesture, so
  // there is still a way out. escRef survives the dismiss because Radix fires onEscapeKeyDown
  // before onOpenChange(false).
  const escRef = useRef(false);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!o && open && !escRef.current) onApply();
        escRef.current = false;
        onOpenChange(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
            // Active filters get a clear filled + ringed treatment so they stand out at a glance.
            count > 0
              ? "bg-brand text-white ring-2 ring-brand/20"
              : "text-neutral-700 hover:bg-neutral-200"
          )}
        >
          {label}
          {count > 0 ? (
            <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-white/25 px-1 text-[11px] font-semibold">{count}</span>
          ) : null}
          <ChevronDown className={cn("ml-0.5 h-4 w-4", count > 0 ? "text-white/70" : "text-neutral-400")} />
        </button>
      </PopoverTrigger>
      {/* A6: the panel is portaled and position:fixed, so page scrolling can never reveal a
          bottom that overflows the viewport — with ~50 selections the Apply row simply sat
          off-screen and zooming out was the only way to reach it. Bound the panel to the space
          Radix already measures, scroll the body, and pin the footer.
          Three details are load-bearing: p-0 here with p-4 on the scroller (otherwise the
          padding sits outside the scroll area and hides the last row), min-h-0 on the scroller
          (a flex child will not shrink below its content without it, which silently defeats the
          whole thing), and collisionPadding (the available-height var is derived from it, and
          the default 0 puts the panel flush against the viewport edge). */}
      <PopoverContent
        align="start"
        sideOffset={6}
        collisionPadding={12}
        onEscapeKeyDown={() => { escRef.current = true; }}
        className={cn(
          "flex max-h-[var(--radix-popover-content-available-height)] flex-col rounded-2xl border-neutral-200 p-0 shadow-xl",
          width
        )}
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        <div className="flex shrink-0 items-center justify-end gap-4 border-t border-neutral-200 px-4 py-3">
          <button type="button" onClick={onClear} className="text-sm font-medium text-neutral-700 hover:text-neutral-900">
            Clear
          </button>
          <button
            type="button"
            onClick={onApply}
            className="rounded-lg bg-brand px-5 py-2 text-sm font-medium text-white hover:bg-brand/90"
          >
            Apply
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Small radio pill (used by include/exclude toggles that live in this file).
export function Radio({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 text-sm text-neutral-800">
      <span className={cn("flex h-4 w-4 items-center justify-center rounded-full border", on ? "border-neutral-900" : "border-neutral-300")}>
        {on && <span className="h-2 w-2 rounded-full bg-neutral-900" />}
      </span>
      {label}
    </button>
  );
}

export function SideRadios({ side, onChange }: { side: VolumeSide; onChange: (s: VolumeSide) => void }) {
  return (
    <div className="mb-3 flex items-center gap-6">
      {SIDES.map(([val, lbl]) => (
        <button key={val} type="button" onClick={() => onChange(val)} className="flex items-center gap-2 text-sm text-neutral-800">
          <span className={cn("flex h-4 w-4 items-center justify-center rounded-full border", side === val ? "border-neutral-900" : "border-neutral-300")}>
            {side === val && <span className="h-2 w-2 rounded-full bg-neutral-900" />}
          </span>
          {lbl}
        </button>
      ))}
    </div>
  );
}

export function BucketPills({ buckets, selected, onToggle }: { buckets: Bucket[]; selected: string[]; onToggle: (k: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {buckets.map((b) => {
        const on = selected.includes(b.key);
        return (
          <button
            key={b.key}
            type="button"
            onClick={() => onToggle(b.key)}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-sm transition-colors",
              on ? "border-brand bg-brand/5 text-brand" : "border-neutral-300 text-neutral-700 hover:bg-neutral-50"
            )}
          >
            {b.label}
          </button>
        );
      })}
    </div>
  );
}

// values are stored as raw digit strings; with `commas` the input DISPLAYS thousands
// separators (3,000,000) while storing "3000000" so the RPC still gets a plain number.
const withCommas = (v: string) => (v === "" ? "" : Number(v).toLocaleString("en-US"));
const stripCommas = (v: string) => v.replace(/[^0-9]/g, "");

export function MinMax({
  min,
  max,
  setMin,
  setMax,
  prefix,
  suffix,
  commas = false,
  disabled = false,
}: {
  min: string;
  max: string;
  setMin: (v: string) => void;
  setMax: (v: string) => void;
  prefix?: string;
  suffix?: string;
  commas?: boolean;
  disabled?: boolean;
}) {
  const field = (val: string, set: (v: string) => void, ph: string) => (
    <div className="relative flex-1">
      {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400">{prefix}</span>}
      <input
        value={commas ? withCommas(val) : val}
        onChange={(e) => set(commas ? stripCommas(e.target.value) : e.target.value)}
        inputMode="numeric"
        placeholder={ph}
        disabled={disabled}
        className={cn(
          "h-10 w-full rounded-lg border border-neutral-300 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none",
          disabled && "cursor-not-allowed bg-neutral-50 text-neutral-400",
          prefix ? "pl-7" : "pl-3",
          suffix ? "pr-10" : "pr-3"
        )}
      />
      {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400">{suffix}</span>}
    </div>
  );
  return (
    <div className="mt-4 flex items-center gap-3">
      {field(min, setMin, "Min")}
      <span className="text-neutral-400">-</span>
      {field(max, setMax, "Max")}
    </div>
  );
}

// ---------- Range filter (Sales volume, Closed units/transactions [hasSide], Est. time, GCI) ----------
export interface RangeValue {
  side: VolumeSide;
  buckets: string[];
  min: string;
  max: string;
}

export function RangePopover({
  label,
  value,
  onChange,
  buckets,
  hasSide = false,
  prefix,
  suffix,
}: {
  label: string;
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  buckets: Bucket[];
  hasSide?: boolean;
  prefix?: string;
  suffix?: string;
}) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<VolumeSide>(value.side);
  const [sel, setSel] = useState<string[]>(value.buckets);
  const [min, setMin] = useState(value.min);
  const [max, setMax] = useState(value.max);

  useEffect(() => {
    if (open) {
      setSide(value.side);
      setSel(value.buckets);
      setMin(value.min);
      setMax(value.max);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = value.buckets.length + (value.min ? 1 : 0) + (value.max ? 1 : 0);
  // Presets and a custom range are mutually exclusive — picking one disables the other. If a
  // filter somehow arrives with BOTH set (e.g. a legacy saved view), keep both editable so the
  // user can resolve it instead of deadlocking; disable only when exactly one side is active.
  const hasCustom = !!min || !!max;
  const hasBuckets = sel.length > 0;
  const disablePills = hasCustom && !hasBuckets;
  const disableCustom = hasBuckets && !hasCustom;
  const toggle = (k: string) => {
    if (disablePills) return;
    setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  };

  return (
    <FilterPopoverShell
      label={label}
      count={count}
      open={open}
      onOpenChange={setOpen}
      onClear={() => {
        setSide("all");
        setSel([]);
        setMin("");
        setMax("");
        onChange({ side: "all", buckets: [], min: "", max: "" }); // Clear applies immediately (A4)
      }}
      onApply={() => {
        onChange({ side, buckets: sel, min, max });
        setOpen(false);
      }}
    >
      {hasSide && <SideRadios side={side} onChange={setSide} />}
      <div className={cn(disablePills && "pointer-events-none opacity-40")}>
        <BucketPills buckets={buckets} selected={sel} onToggle={toggle} />
      </div>
      <MinMax min={min} max={max} setMin={setMin} setMax={setMax} prefix={prefix} suffix={suffix} commas={prefix === "$"} disabled={disableCustom} />
      {hasBuckets && hasCustom ? (
        <p className="mt-2 text-xs text-amber-600">Using both a preset and a custom range — clear one.</p>
      ) : disableCustom ? (
        <p className="mt-2 text-xs text-neutral-400">Clear the presets to enter a custom range.</p>
      ) : disablePills ? (
        <p className="mt-2 text-xs text-neutral-400">Clear the range to use presets.</p>
      ) : null}
    </FilterPopoverShell>
  );
}

// ---------- Zillow / Realtor extras (one chip, all five controls inside) ----------
import type { ZillowRealtorFilter } from "@/types/agent-filters";
import { zillowRealtorCount } from "@/types/agent-filters";

export function ZillowRealtorPopover({ value, onChange }: { value: ZillowRealtorFilter; onChange: (v: ZillowRealtorFilter) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ZillowRealtorFilter>(value);
  const [langInput, setLangInput] = useState("");

  useEffect(() => {
    if (open) {
      setDraft(value);
      setLangInput("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const addLang = () => {
    const v = langInput.trim();
    if (v && !draft.languages.includes(v)) setDraft({ ...draft, languages: [...draft.languages, v] });
    setLangInput("");
  };
  const mm = (label: string, key: "totalSales" | "avgPriceAllTime" | "avgVolumeAllTime", prefix?: string) => (
    <div>
      <div className="mb-1 text-xs font-medium text-neutral-500">{label}</div>
      <div className="flex items-center gap-2">
        {(["min", "max"] as const).map((k) => (
          <div key={k} className="relative flex-1">
            {prefix && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400">{prefix}</span>}
            <input
              value={prefix === "$" ? withCommas(draft[key][k]) : draft[key][k]}
              onChange={(e) => setDraft({ ...draft, [key]: { ...draft[key], [k]: prefix === "$" ? stripCommas(e.target.value) : e.target.value } })}
              inputMode="numeric"
              placeholder={k === "min" ? "Min" : "Max"}
              className={cn("h-9 w-full rounded-lg border border-neutral-300 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none", prefix ? "pl-7 pr-3" : "px-3")}
            />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <FilterPopoverShell
      label="Zillow / Realtor"
      count={zillowRealtorCount(value)}
      open={open}
      onOpenChange={setOpen}
      width="w-96"
      onClear={() => {
        const empty = { languages: [], totalSales: { min: "", max: "" }, avgPriceAllTime: { min: "", max: "" }, avgVolumeAllTime: { min: "", max: "" }, hasLinkedin: false };
        setDraft(empty);
        setLangInput("");
        onChange(empty); // Clear applies immediately (A4)
      }}
      onApply={() => {
        // commit any language still sitting in the input (typed but Enter not pressed)
        const pending = langInput.trim();
        const languages = pending && !draft.languages.includes(pending) ? [...draft.languages, pending] : draft.languages;
        onChange({ ...draft, languages });
        setOpen(false);
      }}
    >
      <div className="space-y-4">
        <div>
          <div className="mb-1 text-xs font-medium text-neutral-500">Languages spoken</div>
          <input
            value={langInput}
            onChange={(e) => setLangInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLang();
              }
            }}
            placeholder="Type a language and press Enter (e.g. Spanish)"
            className="h-9 w-full rounded-lg border border-neutral-300 px-3 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
          />
          {draft.languages.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {draft.languages.map((l) => (
                <span key={l} className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-1 text-xs text-neutral-800">
                  {l}
                  <button type="button" onClick={() => setDraft({ ...draft, languages: draft.languages.filter((x) => x !== l) })} className="text-neutral-400 hover:text-neutral-700">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        {mm("Total sales (all time)", "totalSales", "#")}
        {mm("Avg. price (all time)", "avgPriceAllTime", "$")}
        {mm("Avg. sales volume (all time)", "avgVolumeAllTime", "$")}
        <div className="flex items-center gap-2 text-sm text-neutral-800">
          <Checkbox checked={draft.hasLinkedin} onCheckedChange={() => setDraft({ ...draft, hasLinkedin: !draft.hasLinkedin })} />
          <button type="button" onClick={() => setDraft({ ...draft, hasLinkedin: !draft.hasLinkedin })}>
            Has LinkedIn profile
          </button>
        </div>
      </div>
    </FilterPopoverShell>
  );
}

// ---------- Client (orchestrator client — narrows to the agents built for that client) ----------
interface OrchClient {
  id: string;
  client_name: string | null;
  status: string | null;
  lead_count: number;      // orchestrator/scraper list (new clients pre-send)
  bison_leads: number;     // what's actually in the sequencer (source of truth once > 0)
  bison_matched: number;   // of those, leads that exist in our DB (what the grid can show)
}

export function ClientPopover({
  value,
  clientMode,
  onChange,
}: {
  value: string[];
  clientMode: "include" | "exclude";
  onChange: (ids: string[], mode: "include" | "exclude") => void;
}) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>(value);
  const [mode, setMode] = useState<"include" | "exclude">(clientMode);
  const [clients, setClients] = useState<OrchClient[] | null>(null);
  const [bisonTotal, setBisonTotal] = useState<{ total: number; matched: number } | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (open) {
      setSel(value);
      setMode(clientMode);
      if (clients === null) {
        // ALL clients (existing + imported) — each shows its lead count; picking one filters
        // to the agents on that client's lead list (orch_client_leads).
        fetch("/api/orch/clients")
          .then((r) => r.json())
          .then((j) => {
            setClients(j.clients ?? []);
            setBisonTotal(j.bison ?? null);
          })
          .catch(() => setClients([]));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <FilterPopoverShell
      label="Client"
      count={value.length}
      open={open}
      onOpenChange={setOpen}
      width="w-80"
      onClear={() => {
        setSel([]);
        setMode("include");
        onChange([], "include"); // Clear applies immediately (A4)
      }}
      onApply={() => {
        onChange(sel, mode);
        setOpen(false);
      }}
    >
      {/* Include = only these clients' leads; Exclude = everyone but them (skip agents already
          built for any selected client). Multiple clients are unioned. */}
      <div className="mb-2 flex items-center gap-6">
        <Radio label="Include" on={mode === "include"} onClick={() => setMode("include")} />
        <Radio label="Exclude" on={mode === "exclude"} onClick={() => setMode("exclude")} />
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search clients"
        className="mb-2 h-9 w-full rounded-lg border border-neutral-300 px-3 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
      />
      <div className="mb-1 flex items-center justify-between px-1 text-xs">
        <span className="text-neutral-400">{sel.length} out of {clients?.length ?? 0} selected</span>
        <div className="flex gap-3">
          {/* no-op while the list is loading — otherwise this would wipe the seeded selection.
              Select all covers only the clients the search box currently SHOWS. */}
          <button
            type="button"
            className="text-neutral-600 hover:underline"
            onClick={() => {
              if (!clients?.length) return;
              const shown = clients.filter((c) => !q.trim() || (c.client_name ?? "").toLowerCase().includes(q.trim().toLowerCase()));
              setSel((s) => [...new Set([...s, ...shown.map((c) => c.id)])]);
            }}
          >
            Select all
          </button>
          <button
            type="button"
            className="text-neutral-600 hover:underline"
            onClick={() => {
              setSel([]);
              setMode("include");
              onChange([], "include"); // Clear applies immediately (A4)
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="max-h-64 space-y-1 overflow-auto">
        {clients === null ? (
          <p className="py-4 text-center text-sm text-neutral-400">Loading…</p>
        ) : clients.length === 0 ? (
          <p className="py-4 text-center text-sm text-neutral-400">No clients yet.</p>
        ) : (
          <>
            {clients.filter((c) => !q.trim() || (c.client_name ?? "").toLowerCase().includes(q.trim().toLowerCase())).map((c) => {
              const on = sel.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggle(c.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm",
                    on ? "bg-neutral-100 text-neutral-900" : "text-neutral-800 hover:bg-neutral-50"
                  )}
                >
                  <Checkbox checked={on} onCheckedChange={() => toggle(c.id)} onClick={(e) => e.stopPropagation()} aria-label={c.client_name ?? "Unnamed client"} />
                  <span className="min-w-0 flex-1 truncate">{c.client_name ?? "Unnamed client"}</span>
                  {c.bison_leads > 0 ? (
                    <span className="shrink-0 text-xs text-neutral-400" title={`${c.bison_leads.toLocaleString()} in Bison campaigns · ${c.bison_matched.toLocaleString()} in the database`}>
                      {c.bison_leads.toLocaleString()} in Bison
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-neutral-400">{c.lead_count.toLocaleString()} leads</span>
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>
      {bisonTotal && bisonTotal.total > 0 && (
        <p className="mt-2 border-t border-neutral-100 px-1 pt-2 text-xs text-neutral-500">
          {bisonTotal.total.toLocaleString()} leads in Bison across all clients ({bisonTotal.matched.toLocaleString()} in the database)
        </p>
      )}
    </FilterPopoverShell>
  );
}

// ---------- Contact (has / missing per channel — A3's include/exclude model) ----------
export type ContactValue = {
  email: "" | "has" | "missing";
  phone: "" | "has" | "missing";
  enriched: "" | "has" | "missing"; // C2: went through enrichment and holds a verified email
  inCampaign: "" | "has" | "missing"; // C5: already in a client's Bison campaign
  replied: "" | "has" | "missing"; // C4: has ever replied (Bison sync)
  bounced: "" | "has" | "missing"; // C1: emails bounced (Bison sync)
};
export function ContactPopover({ value, onChange }: { value: ContactValue; onChange: (v: ContactValue) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (open) setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = (value.email ? 1 : 0) + (value.phone ? 1 : 0); // enriched/inCampaign live in the All-filters drawer
  const LABELS: Record<string, [string, string]> = {
    email: ["Has email", "No email"],
    phone: ["Has phone", "No phone"],
    enriched: ["Enriched", "Not enriched"],
    inCampaign: ["In campaign", "Not in campaign"],
  };
  const row = (k: "email" | "phone" | "enriched" | "inCampaign", label: string) => (
    <div>
      <div className="mb-1.5 text-xs font-medium text-neutral-500">{label}</div>
      <div className="flex items-center gap-5">
        {([["", "Any"], ["has", LABELS[k][0]], ["missing", LABELS[k][1]]] as const).map(([v, lbl]) => (
          <Radio key={v || "any"} label={lbl} on={draft[k] === v} onClick={() => setDraft({ ...draft, [k]: v })} />
        ))}
      </div>
    </div>
  );
  return (
    <FilterPopoverShell
      label="Contact"
      count={count}
      open={open}
      onOpenChange={setOpen}
      width="w-80"
      onClear={() => {
        setDraft({ ...value, email: "", phone: "" });
        onChange({ ...value, email: "", phone: "" }); // Clear applies immediately (A4); drawer-owned toggles stay
      }}
      onApply={() => {
        onChange(draft);
        setOpen(false);
      }}
    >
      <div className="space-y-3.5">
        {row("email", "Email address")}
        {row("phone", "Phone number")}
      </div>
    </FilterPopoverShell>
  );
}

// ---------- Title (include/exclude over the 3 fixed roles) ----------
export function TitlePopover({ value, onChange }: { value: IncludeExclude; onChange: (v: IncludeExclude) => void }) {
  const [open, setOpen] = useState(false);
  const [inc, setInc] = useState<string[]>(value.include);
  const [exc, setExc] = useState<string[]>(value.exclude);

  useEffect(() => {
    if (open) {
      setInc(value.include);
      setExc(value.exclude);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = value.include.length + value.exclude.length;
  const toggleInc = (t: string) => {
    setInc((a) => (a.includes(t) ? a.filter((x) => x !== t) : [...a, t]));
    setExc((a) => a.filter((x) => x !== t));
  };
  const toggleExc = (t: string) => {
    setExc((a) => (a.includes(t) ? a.filter((x) => x !== t) : [...a, t]));
    setInc((a) => a.filter((x) => x !== t));
  };

  return (
    <FilterPopoverShell
      label="Title"
      count={count}
      open={open}
      onOpenChange={setOpen}
      width="w-80"
      onClear={() => {
        setInc([]);
        setExc([]);
        onChange({ include: [], exclude: [] }); // Clear applies immediately (A4)
      }}
      onApply={() => {
        onChange({ include: inc, exclude: exc });
        setOpen(false);
      }}
    >
      <div className="mb-2 grid grid-cols-[1fr_auto_auto] items-center gap-x-6 text-xs font-medium text-neutral-500">
        <span />
        <span>Include</span>
        <span>Exclude</span>
      </div>
      <div className="space-y-2">
        {TITLES.map((t) => (
          <div key={t} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6">
            <span className="text-sm text-neutral-800">{t}</span>
            <div className="flex w-12 justify-center">
              <Checkbox checked={inc.includes(t)} onCheckedChange={() => toggleInc(t)} aria-label={`Include ${t}`} />
            </div>
            <div className="flex w-12 justify-center">
              <Checkbox checked={exc.includes(t)} onCheckedChange={() => toggleExc(t)} aria-label={`Exclude ${t}`} />
            </div>
          </div>
        ))}
      </div>
    </FilterPopoverShell>
  );
}

// A view saved while no filters were applied matches the whole database. That is almost never
// intended — it happened in production and made every search that referenced it scan 1.1M rows —
// so anything this broad is flagged in the list rather than silently behaving like "no filter".
const EMPTY_VIEW_THRESHOLD = 1_000_000;

// ---------- Saved views as include/exclude sets (A12) ----------
interface SavedViewOpt {
  id: string;
  name: string;
  count: number | null; // cached agent count (B4) — refreshed on save/edit/import/6h sync
}
interface SavedViewTotals {
  union_count: number | null; // unique agents in at least one view
  sum_count: number | string | null;
  refreshed_at: string | null;
}
export function SavedViewsPopover({
  value,
  onChange,
}: {
  value: { include: string[]; exclude: string[] };
  onChange: (v: { include: string[]; exclude: string[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedViewOpt[] | null>(null);
  const [totals, setTotals] = useState<SavedViewTotals | null>(null);
  const [inc, setInc] = useState<string[]>(value.include);
  const [exc, setExc] = useState<string[]>(value.exclude);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (open) {
      setInc(value.include);
      setExc(value.exclude);
      if (views === null) {
        fetch("/api/lists")
          .then((r) => r.json())
          .then((j) => {
            setViews(
              ((j.lists ?? []) as { id: string; name: string; cached_count?: number | null }[]).map((l) => ({
                id: l.id,
                name: l.name,
                count: l.cached_count ?? null,
              }))
            );
            setTotals((j.totals as SavedViewTotals) ?? null);
          })
          .catch(() => setViews([]));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = value.include.length + value.exclude.length;
  const pick = (id: string, mode: "include" | "exclude") => {
    if (mode === "include") {
      setInc((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
      setExc((a) => a.filter((x) => x !== id));
    } else {
      setExc((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
      setInc((a) => a.filter((x) => x !== id));
    }
  };
  const shown = (views ?? []).filter((v) => !q.trim() || v.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <FilterPopoverShell
      label="Saved views"
      count={count}
      open={open}
      onOpenChange={setOpen}
      width="w-[400px]"
      onClear={() => {
        setInc([]);
        setExc([]);
        onChange({ include: [], exclude: [] }); // Clear applies immediately (A4)
      }}
      onApply={() => {
        onChange({ include: inc, exclude: exc });
        setOpen(false);
      }}
    >
      <p className="mb-2 text-xs text-neutral-500">
        Include = only agents in ANY of the chosen views; Exclude = hide agents in any of them. Evaluated
        live, so it always reflects each view&apos;s current membership.
      </p>
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-neutral-400" title={totals?.refreshed_at ? `Counts as of ${new Date(totals.refreshed_at).toLocaleString()}` : undefined}>
          {totals?.union_count != null && (
            <>
              All views: <span className="font-medium text-neutral-700">{totals.union_count.toLocaleString()}</span> unique agents
            </>
          )}
        </span>
        <div className="flex shrink-0 gap-3">
          <button
            type="button"
            className="text-neutral-600 hover:underline"
            onClick={() => {
              const ids = shown.map((v) => v.id); // acts on the rows currently listed (search-filtered)
              setInc((a) => Array.from(new Set([...a, ...ids])));
              setExc((a) => a.filter((x) => !ids.includes(x)));
            }}
          >
            Include all
          </button>
          <button
            type="button"
            className="text-neutral-600 hover:underline"
            onClick={() => {
              const ids = shown.map((v) => v.id);
              setExc((a) => Array.from(new Set([...a, ...ids])));
              setInc((a) => a.filter((x) => !ids.includes(x)));
            }}
          >
            Exclude all
          </button>
        </div>
      </div>
      {views && views.length > 6 && (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search views"
          className="mb-2 h-9 w-full rounded-lg border border-neutral-300 px-3 text-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
        />
      )}
      <div className="max-h-64 space-y-1 overflow-auto">
        {views === null ? (
          <p className="py-4 text-center text-sm text-neutral-400">Loading…</p>
        ) : views.length === 0 ? (
          <p className="py-4 text-center text-sm text-neutral-400">No saved views yet — save one from the disk icon first.</p>
        ) : shown.length === 0 ? (
          <p className="py-4 text-center text-sm text-neutral-400">No matches.</p>
        ) : (
          shown.map((v) => {
            const on = inc.includes(v.id) ? "include" : exc.includes(v.id) ? "exclude" : "off";
            return (
              <div key={v.id} className="flex items-center gap-2 rounded-lg px-1 py-1">
                {/* One-click tick = Include, mirroring the tick in the save panel so the two
                    places behave the same. Include/Exclude stay: the tick is a shortcut for the
                    common case, not a replacement — Exclude has no tick equivalent, and a row
                    that is excluded reads as unticked (it is not included). */}
                <button
                  type="button"
                  onClick={() => pick(v.id, "include")}
                  aria-pressed={on === "include"}
                  title={on === "include" ? `Stop filtering by "${v.name}"` : `Filter by "${v.name}"`}
                  className="shrink-0 text-neutral-400 hover:text-brand"
                >
                  {on === "include" ? (
                    <span className="flex h-4 w-4 items-center justify-center rounded border border-brand bg-brand text-white">
                      <Check className="h-3 w-3" />
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "block h-4 w-4 rounded border",
                        on === "exclude" ? "border-red-300 bg-red-50" : "border-neutral-300"
                      )}
                    />
                  )}
                </button>
                <span className="min-w-0 flex-1 truncate text-sm text-neutral-800" title={v.name}>{v.name}</span>
                {v.count != null && (
                  <span
                    className={cn("shrink-0 text-xs tabular-nums", v.count > EMPTY_VIEW_THRESHOLD ? "font-medium text-amber-600" : "text-neutral-400")}
                    title={v.count > EMPTY_VIEW_THRESHOLD ? "This view matches almost the whole database — it was probably saved with no filters applied. Re-save it with the filters you want." : undefined}
                  >
                    {v.count.toLocaleString()}{v.count > EMPTY_VIEW_THRESHOLD ? " ⚠" : ""}
                  </span>
                )}
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => pick(v.id, "include")}
                    className={cn(
                      "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                      on === "include" ? "border-brand bg-brand/10 text-brand" : "border-neutral-300 text-neutral-600 hover:bg-neutral-50"
                    )}
                  >
                    Include
                  </button>
                  <button
                    type="button"
                    onClick={() => pick(v.id, "exclude")}
                    className={cn(
                      "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                      on === "exclude" ? "border-red-300 bg-red-50 text-red-700" : "border-neutral-300 text-neutral-600 hover:bg-neutral-50"
                    )}
                  >
                    Exclude
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </FilterPopoverShell>
  );
}
