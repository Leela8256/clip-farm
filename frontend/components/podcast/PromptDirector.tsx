"use client";

import { useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronRight, Loader2, Sparkles, Wand2 } from "lucide-react";
import {
  ASPECT_RATIOS,
  CAPTION_PRESETS,
  DURATION_MODES,
  EXCLUDABLE_CONTENT,
  FILLER_POLICIES,
  SILENCE_POLICIES,
  type DirectorRequest,
  type DurationMode,
  type FillerPolicy,
  type RequestSpec,
  type SilencePolicy,
} from "@/lib/director";
import { DIRECTOR_PRESETS, describeStatus, type ProjectIndex, type StatusEvent } from "@/lib/podcast";
import type { ParsedPrompt } from "@/lib/engine";

// ----------------------------------------------------------------- copy

type Tone = "ok" | "warn" | "bad" | "muted";

const PILL: Record<Tone, string> = {
  ok: "bg-ready/10 text-ready",
  warn: "bg-processing/10 text-processing",
  bad: "bg-danger/10 text-danger",
  muted: "bg-surface-overlay text-ink-dim",
};

const ASPECT_NAMES: Record<string, string> = { "9:16": "vertical", "16:9": "wide", "1:1": "square", "4:5": "portrait" };
const MODE_LABELS: Record<DurationMode, string> = { natural: "about (±3 s)", strict: "exactly (±1 s)", maximum: "at most" };
const FILLER_LABELS: Record<FillerPolicy, string> = { smart: "smart", cut: "cut", mute: "muted", keep: "kept" };
const SILENCE_LABELS: Record<SilencePolicy, string> = { tighten: "tightened", keep: "kept" };
const CAPTION_LABELS: Record<string, string> = { classic: "classic", "yellow-bold": "yellow", "white-outline": "white outline", minimal: "minimal", off: "off" };

const durationLabel = (d: RequestSpec["duration"]) =>
  d.mode === "strict" ? `${d.target_seconds} s strict` : d.mode === "maximum" ? `up to ${d.target_seconds} s` : `about ${d.target_seconds} s`;

const parseList = (v: string) =>
  v
    .split(/[;,]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

/** A few words for a warning pill; the full sentence goes in the tooltip. */
function shortWarning(w: string): string {
  if (/^Speaker constraints/i.test(w)) return "speakers matched by name";
  if (/clamped/i.test(w)) return "clip count adjusted";
  if (/too short/i.test(w)) return "length raised to 5 s";
  if (/too long/i.test(w)) return "length capped at 10 min";
  if (/^Strict duration/i.test(w)) return "strict length ignores min/max";
  if (/rendering 9:16 for now/i.test(w)) return "exports as 9:16 for now";
  const unknown = /^Unknown ([a-z ]+) '/i.exec(w);
  if (unknown) return `unknown ${unknown[1]} — default used`;
  const content = /^Can't filter content of type '([^']+)'/i.exec(w);
  if (content) return `“${content[1]}” treated as a subject`;
  const head = w.split(/ — |\(/)[0].trim().replace(/\.$/, "");
  return head.length > 44 ? `${head.slice(0, 43).trimEnd()}…` : head;
}

/** The stage name in the producer's words. */
function friendlyStatus(evt: StatusEvent | null, busy: "parsing" | "directing"): string {
  if (!evt) return busy === "parsing" ? "Reading your request" : "Getting ready";
  const text = describeStatus(evt);
  if (/^Waiting/.test(text)) return "Getting ready";
  return text
    .replace(/^Claude is scoring/, "Scoring")
    .replace(/^Indexing\s*(\S*)\s*transcript passages/, (_m, n: string) => `Preparing transcript search${n ? ` · ${n} passages` : ""}`)
    .replace(/^Transcript index ready/, "Transcript search ready")
    .replace(/ on the engine/, "")
    .replace(/^podcast_\w+: \w+$/, "Working on it")
    .trim();
}

const requestLabel = (r: DirectorRequest) =>
  r.status === "done"
    ? `${r.compliance?.delivered ?? r.candidates?.length ?? 0}/${r.spec.count}`
    : r.status === "running"
      ? "running"
      : r.status === "error"
        ? "failed"
        : "not run";

// ------------------------------------------------------------ primitives

function Pill({ children, tone = "muted", title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${PILL[tone]}`}>
      {children}
    </span>
  );
}

function Warning({ text }: { text: string }) {
  return (
    <Pill tone="warn" title={text}>
      <AlertTriangle className="h-3 w-3" /> {shortWarning(text)}
    </Pill>
  );
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group mt-2">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-ink-dim hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" /> {title}
      </summary>
      <div className="mt-1.5 pl-5">{children}</div>
    </details>
  );
}

/** An input that takes focus as soon as its popover opens. */
function FocusInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return <input ref={ref} {...props} />;
}

/** Comma-separated list editing that keeps what you typed (the spec gets the parsed list). */
function ListEditor({ value, placeholder, onChange, onDone }: { value: string[]; placeholder: string; onChange: (v: string[]) => void; onDone: () => void }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <FocusInput
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onDone();
        }
      }}
      className="rr-input rr-input-sm w-64"
    />
  );
}

/** One fact of the request as a chip; clicking opens a small popover with its control. */
function SpecChip({ label, value, active, onOpen, onDone, children }: { label: string; value: string; active: boolean; onOpen: () => void; onDone: () => void; children: ReactNode }) {
  return (
    <span className="relative inline-flex">
      <button type="button" onClick={onOpen} data-active={active} aria-expanded={active} className="rr-chip max-w-[18rem]">
        <span className={active ? "opacity-60" : "text-ink-faint"}>{label}</span>
        <span className="min-w-0 truncate">{value}</span>
      </button>
      {active && (
        <div
          role="dialog"
          aria-label={`Edit ${label}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onDone();
            }
          }}
          className="rr-enter absolute left-0 top-full z-20 mt-1.5 flex min-w-[240px] flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface-raised p-2 shadow-elev-2"
        >
          {children}
          <button type="button" onClick={onDone} className="rr-btn rr-btn-ghost rr-btn-sm">
            <Check className="h-3.5 w-3.5" /> Done
          </button>
        </div>
      )}
    </span>
  );
}

type ChipKey = "count" | "length" | "who" | "about" | "skip" | "tone" | "opens" | "ends" | "captions" | "frame" | "fillers" | "pauses";

/** The parsed request as editable chips. */
function SpecSummary({ spec, onEditSpec, disabled }: { spec: RequestSpec; onEditSpec: (patch: Partial<RequestSpec>) => void; disabled: boolean }) {
  const [editing, setEditing] = useState<ChipKey | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setEditing(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [editing]);

  const close = () => setEditing(null);
  const chip = (key: ChipKey) => ({ active: editing === key, onOpen: () => setEditing(editing === key ? null : key), onDone: close });
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      close();
    }
  };
  const d = spec.duration;
  const skipped = [...spec.exclude_content, ...spec.exclude_subjects];
  const select = "rr-select rr-select-sm w-auto min-w-[9rem]";

  return (
    <div ref={rootRef} className={`flex flex-wrap items-center gap-1.5 ${disabled ? "pointer-events-none opacity-60" : ""}`}>
      <SpecChip label="clips" value={String(spec.count)} {...chip("count")}>
        <FocusInput type="number" min={1} max={20} value={spec.count} onKeyDown={onKey} onChange={(e) => onEditSpec({ count: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} className="rr-input rr-input-sm w-20" />
      </SpecChip>
      <SpecChip label="length" value={durationLabel(d)} {...chip("length")}>
        <FocusInput
          type="number"
          min={5}
          max={600}
          value={d.target_seconds}
          onKeyDown={onKey}
          onChange={(e) => onEditSpec({ duration: { ...d, target_seconds: Math.min(600, Math.max(5, Number(e.target.value) || 5)) } })}
          className="rr-input rr-input-sm w-24"
        />
        <span className="text-xs text-ink-faint">s</span>
        <select value={d.mode} onChange={(e) => onEditSpec({ duration: { ...d, mode: e.target.value as DurationMode } })} className={select}>
          {DURATION_MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </SpecChip>
      <SpecChip label="who" value={spec.speakers.length ? spec.speakers.join(", ") : "anyone"} {...chip("who")}>
        <ListEditor value={spec.speakers} placeholder="names, comma separated" onChange={(v) => onEditSpec({ speakers: v })} onDone={close} />
      </SpecChip>
      <SpecChip label="about" value={spec.subjects.length ? spec.subjects.join("; ") : "anything"} {...chip("about")}>
        <ListEditor value={spec.subjects} placeholder="subjects, comma separated" onChange={(v) => onEditSpec({ subjects: v })} onDone={close} />
      </SpecChip>
      <SpecChip label="skip" value={skipped.length ? skipped.join(", ") : "nothing"} {...chip("skip")}>
        {EXCLUDABLE_CONTENT.map((k) => {
          const on = spec.exclude_content.includes(k);
          return (
            <button key={k} type="button" data-active={on} onClick={() => onEditSpec({ exclude_content: on ? spec.exclude_content.filter((x) => x !== k) : [...spec.exclude_content, k] })} className="rr-chip">
              {k}
            </button>
          );
        })}
        <ListEditor value={spec.exclude_subjects} placeholder="subjects to avoid" onChange={(v) => onEditSpec({ exclude_subjects: v })} onDone={close} />
      </SpecChip>
      <SpecChip label="tone" value={spec.tone ?? "any"} {...chip("tone")}>
        <FocusInput value={spec.tone ?? ""} placeholder="e.g. playful" onKeyDown={onKey} onChange={(e) => onEditSpec({ tone: e.target.value || null })} className="rr-input rr-input-sm w-56" />
      </SpecChip>
      <SpecChip label="opens with" value={spec.hook ?? "any hook"} {...chip("opens")}>
        <FocusInput value={spec.hook ?? ""} placeholder="e.g. a surprising statement" onKeyDown={onKey} onChange={(e) => onEditSpec({ hook: e.target.value || null })} className="rr-input rr-input-sm w-64" />
      </SpecChip>
      <SpecChip label="ends with" value={spec.ending ?? "a complete thought"} {...chip("ends")}>
        <FocusInput value={spec.ending ?? ""} placeholder="e.g. a takeaway" onKeyDown={onKey} onChange={(e) => onEditSpec({ ending: e.target.value || null })} className="rr-input rr-input-sm w-64" />
      </SpecChip>
      <SpecChip label="captions" value={CAPTION_LABELS[spec.caption_preset] ?? spec.caption_preset} {...chip("captions")}>
        <select value={spec.caption_preset} onChange={(e) => onEditSpec({ caption_preset: e.target.value as RequestSpec["caption_preset"] })} className={select}>
          {CAPTION_PRESETS.map((p) => (
            <option key={p} value={p}>
              {CAPTION_LABELS[p] ?? p}
            </option>
          ))}
        </select>
      </SpecChip>
      <SpecChip label="frame" value={`${spec.aspect_ratio} ${ASPECT_NAMES[spec.aspect_ratio] ?? ""}`.trim()} {...chip("frame")}>
        <select value={spec.aspect_ratio} onChange={(e) => onEditSpec({ aspect_ratio: e.target.value })} className={select}>
          {ASPECT_RATIOS.map((a) => (
            <option key={a} value={a}>
              {a} {ASPECT_NAMES[a]}
            </option>
          ))}
        </select>
      </SpecChip>
      <SpecChip label="fillers" value={FILLER_LABELS[spec.filler_policy] ?? spec.filler_policy} {...chip("fillers")}>
        <select value={spec.filler_policy} onChange={(e) => onEditSpec({ filler_policy: e.target.value as FillerPolicy })} className={select}>
          {FILLER_POLICIES.map((p) => (
            <option key={p} value={p}>
              {FILLER_LABELS[p]}
            </option>
          ))}
        </select>
      </SpecChip>
      <SpecChip label="pauses" value={SILENCE_LABELS[spec.silence_policy] ?? spec.silence_policy} {...chip("pauses")}>
        <select value={spec.silence_policy} onChange={(e) => onEditSpec({ silence_policy: e.target.value as SilencePolicy })} className={select}>
          {SILENCE_POLICIES.map((p) => (
            <option key={p} value={p}>
              {SILENCE_LABELS[p]}
            </option>
          ))}
        </select>
      </SpecChip>
    </div>
  );
}

/** Whether requests are answered from transcript search or by reading everything. */
function SearchStatus({ index, indexing, canBuild, onBuild }: { index: ProjectIndex | undefined; indexing: boolean; canBuild: boolean; onBuild: () => void }) {
  if (indexing) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-processing/10 px-2.5 py-1 text-[11px] font-medium text-processing">
        <Loader2 className="h-3 w-3 animate-spin" /> building transcript search…
      </span>
    );
  }
  if (index?.status === "indexed") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-ready/10 px-2.5 py-1 text-[11px] font-medium text-ready">
        <span className="h-1.5 w-1.5 rounded-full bg-ready" /> transcript search ready · {index.passages ?? "?"} passages
      </span>
    );
  }
  const failed = index?.status === "failed";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        title={failed ? "Transcript search couldn't be built, so the whole transcript is read for each request." : "The whole transcript is read for each request."}
        className="inline-flex items-center gap-1.5 rounded-full bg-surface-overlay px-2.5 py-1 text-[11px] font-medium text-ink-dim"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-ink-faint" /> full transcript
      </span>
      <button type="button" onClick={onBuild} disabled={!canBuild} className="rr-btn rr-btn-ghost rr-btn-sm">
        {failed ? "Try building search again" : "Build transcript search"}
      </button>
    </span>
  );
}

// -------------------------------------------------------------- component

/**
 * Prompt Director: one sentence in, an editable summary of what was
 * understood, then the directed search with an honest compliance summary.
 * Every request is kept under analysis/requests/.
 */
export default function PromptDirector({
  requests,
  activeRequestId,
  onSelectRequest,
  index,
  indexing,
  onBuildIndex,
  draft,
  onParse,
  onEditSpec,
  onRun,
  onDiscard,
  busy,
  events,
  error,
  canRun,
  prefill,
}: {
  requests: DirectorRequest[];
  activeRequestId: string | null;
  onSelectRequest: (id: string | null) => void;
  index: ProjectIndex | undefined;
  indexing: boolean;
  onBuildIndex: () => void;
  draft: ParsedPrompt | null;
  onParse: (prompt: string) => void;
  onEditSpec: (patch: Partial<RequestSpec>) => void;
  onRun: () => void;
  onDiscard: () => void;
  busy: "parsing" | "directing" | null;
  events: StatusEvent[];
  error: string | null;
  canRun: boolean;
  prefill?: string;
}) {
  const [prompt, setPrompt] = useState(prefill ?? "");
  const [elapsed, setElapsed] = useState(0);
  const latest = events[events.length - 1] ?? null;
  const active = requests.find((r) => r.request_id === activeRequestId) ?? null;
  const searchReady = index?.status === "indexed";
  const spec = draft?.spec ?? null;
  const canParse = canRun && busy === null && !!prompt.trim();
  const notes = ((active?.compliance as { notes?: string[] } | undefined)?.notes ?? []).filter((n) => n.trim());

  const submit = () => {
    if (canParse) onParse(prompt);
  };
  const onPromptKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  useEffect(() => {
    if (busy === null) return;
    const started = Date.now();
    const tick = () => setElapsed(Math.round((Date.now() - started) / 1000));
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [busy]);

  return (
    <section className="rr-card rr-enter p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="rr-h3">Describe the clips you want</h3>
        <SearchStatus index={index} indexing={indexing} canBuild={canRun && busy === null} onBuild={onBuildIndex} />
      </div>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onPromptKey}
        rows={4}
        disabled={busy !== null}
        placeholder="Three 42-second clips where Sarah explains why the startup failed. Open with a surprising statement, cut the filler words, no profanity, yellow captions, and end on a complete takeaway."
        className="rr-textarea mt-4 disabled:opacity-60"
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {DIRECTOR_PRESETS.map((p) => (
          <button key={p.label} type="button" disabled={busy !== null} aria-pressed={prompt === p.text} onClick={() => setPrompt(p.text)} className="rr-chip disabled:opacity-50">
            {p.label}
          </button>
        ))}
        <span className="flex-1" />
        <span className="hidden items-center gap-1 text-[11px] text-ink-faint sm:inline-flex" title="Cmd/Ctrl + Enter sends the request">
          <kbd className="rr-kbd">⌘</kbd>
          <kbd className="rr-kbd">↵</kbd>
        </span>
        <button type="button" onClick={submit} disabled={!canParse} className="rr-btn rr-btn-primary">
          {busy === "parsing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
          Understand the request
        </button>
      </div>

      {spec && draft && (
        <div className="rr-enter mt-4 rounded-md border border-line bg-surface-overlay/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-ink-dim">Here is the plan — click a chip to change it</span>
            <span className="truncate font-mono text-[11px] text-ink-faint" title="The phrase used to search the transcript">
              “{draft.searchQuery}”
            </span>
          </div>
          <div className="mt-3">
            <SpecSummary spec={spec} onEditSpec={onEditSpec} disabled={busy !== null} />
          </div>
          {spec.warnings.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {spec.warnings.map((w, i) => (
                <Warning key={i} text={w} />
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" onClick={onRun} disabled={!canRun || busy !== null} className="rr-btn rr-btn-primary">
              {busy === "directing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-accent" />}
              Find the clips
            </button>
            <button type="button" onClick={onDiscard} disabled={busy !== null} className="rr-btn rr-btn-ghost">
              Discard
            </button>
            <span className="ml-auto text-[11px] text-ink-faint">{searchReady ? "using transcript search" : "reading the full transcript"}</span>
          </div>
        </div>
      )}

      {busy !== null && (
        <div className="rr-enter mt-4" role="status">
          <div className="rr-progress" data-indeterminate="true">
            <i style={{ width: "35%" }} />
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-ink-dim">
            <span>{friendlyStatus(latest, busy)}</span>
            <span className="font-mono text-[11px] text-ink-faint">{elapsed}s</span>
          </div>
        </div>
      )}
      {error && (
        <div className="rr-enter mt-3 flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {requests.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => onSelectRequest(null)} className={`rr-chip ${activeRequestId === null ? "rr-chip-accent" : ""}`}>
              all clips
            </button>
            {requests.map((r) => (
              <button key={r.request_id} type="button" onClick={() => onSelectRequest(r.request_id)} title={r.prompt} className={`rr-chip ${activeRequestId === r.request_id ? "rr-chip-accent" : ""}`}>
                {r.status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
                {r.request_id} · {requestLabel(r)}
              </button>
            ))}
          </div>
          {active && (
            <div key={active.request_id} className="rr-enter mt-3 rounded-md border border-line p-3">
              <p className="text-sm text-ink">&ldquo;{active.prompt}&rdquo;</p>
              {active.summary && <p className="mt-1 text-xs text-ink-faint">{active.summary}</p>}
              {active.status === "error" && active.error && (
                <div className="mt-2 flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{active.error}</span>
                </div>
              )}
              {active.compliance && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Pill tone={active.compliance.delivered >= active.compliance.requested ? "ok" : "warn"}>
                    {active.compliance.delivered} of {active.compliance.requested} delivered
                  </Pill>
                  <Pill>
                    {active.compliance.proposed} proposed · {active.compliance.rejected} rejected
                  </Pill>
                  {Object.entries(active.compliance.rejection_reasons ?? {}).map(([reason, n]) => (
                    <Pill key={reason}>
                      {n}× {reason.replace(/_/g, " ")}
                    </Pill>
                  ))}
                  {active.mode && <Pill>{active.mode === "index" ? "transcript search" : "full transcript"}</Pill>}
                  {(active.compliance.warnings ?? []).map((w, i) => (
                    <Warning key={i} text={w} />
                  ))}
                </div>
              )}
              {notes.length > 0 && (
                <Disclosure title="Why these clips">
                  <div className="space-y-1 text-xs leading-relaxed text-ink-dim">
                    {notes.map((n, i) => (
                      <p key={i}>{n}</p>
                    ))}
                  </div>
                </Disclosure>
              )}
              {active.rejected && active.rejected.length > 0 && (
                <Disclosure title="Why the others were dropped">
                  <ul className="space-y-0.5 text-xs text-ink-faint">
                    {active.rejected.map((r, i) => (
                      <li key={i}>
                        <span className="text-ink-dim">{r.title ?? "untitled"}</span> — {(r.rejected_for ?? []).join("; ").replace(/_/g, " ")}
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
