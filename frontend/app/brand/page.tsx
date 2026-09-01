"use client";

import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Check, Loader2, Star, TriangleAlert } from "lucide-react";
import { getClient, getConnectionState, subscribeConnection } from "@/lib/engine";
import { listTemplates, loadTemplate, resolveCaptionStyle, saveTemplate, setDefaultTemplate, type BrandTemplate } from "@/lib/brand";
import { listProjects, type ProjectSummary } from "@/lib/library";
import { ASPECT_RATIOS, DURATION_MODES, FILLER_POLICIES, SILENCE_POLICIES } from "@/lib/director";
import { LAYOUT_MODES } from "@/lib/podcast";
import CaptionDesigner from "@/components/brand/CaptionDesigner";
import AssetField from "@/components/brand/AssetField";
import SampleRender from "@/components/brand/SampleRender";
import { toast } from "@/components/shell/Toasts";

const serverState = () => "idle" as const;

const CORNERS = [
  { value: "tl", label: "Top left" },
  { value: "tr", label: "Top right" },
  { value: "bl", label: "Bottom left" },
  { value: "br", label: "Bottom right" },
];

const FILLER_LABELS: Record<string, string> = {
  smart: "Take out the obvious ums",
  cut: "Take out every filler word",
  mute: "Mute filler words",
  keep: "Leave them in",
};
const SILENCE_LABELS: Record<string, string> = { tighten: "Tighten long pauses", keep: "Leave pauses as they are" };
const MODE_LABELS: Record<string, string> = {
  natural: "Let the length follow the moment",
  strict: "Hold the exact length",
  maximum: "Never go over the length",
};
const ASPECT_LABELS: Record<string, string> = { "9:16": "Tall (9:16)", "4:5": "Portrait (4:5)", "1:1": "Square (1:1)", "16:9": "Wide (16:9)" };

type Tab = "captions" | "look" | "sound" | "defaults";
const TABS: { key: Tab; label: string }[] = [
  { key: "captions", label: "Captions" },
  { key: "look", label: "Logo & text" },
  { key: "sound", label: "Intro, outro & music" },
  { key: "defaults", label: "Starting points" },
];

/** Static-export friendly route: /brand?id=<template>. useSearchParams needs a Suspense boundary. */
export default function BrandPage() {
  return (
    <Suspense fallback={null}>
      <BrandEditor />
    </Suspense>
  );
}

function BrandEditor() {
  const id = useSearchParams().get("id") ?? "";
  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, serverState);

  const [template, setTemplate] = useState<BrandTemplate | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [siblings, setSiblings] = useState<BrandTemplate[]>([]);
  const [tab, setTab] = useState<Tab>("captions");

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState("");
  const [revision, setRevision] = useState(0);

  const latest = useRef<BrandTemplate | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    if (connection === "connected") return;
    const kick = () => void getClient().catch(() => {});
    const first = setTimeout(kick, 0);
    const retry = setInterval(kick, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(retry);
    };
  }, [connection]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const found = await loadTemplate(id);
      if (!found) {
        setMissing(true);
        return;
      }
      latest.current = found;
      setTemplate(found);
      setRevision(found.revision ?? 0);
      setLoadError("");
      const [listing, all] = await Promise.all([listProjects(), listTemplates()]);
      setProjects(listing.projects);
      setSiblings(all);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    if (connection !== "connected" || !id) return;
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [connection, id, load]);

  const flush = useCallback(async () => {
    const next = latest.current;
    if (!next || !dirty.current) return;
    dirty.current = false;
    setSaving(true);
    try {
      const saved = await saveTemplate(next);
      setRevision(saved.revision ?? 0);
      setSavedAt(Date.now());
      setSaveError("");
    } catch (e) {
      dirty.current = true;
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  // A last write when the producer leaves the screen mid-edit.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current) void flush();
    };
  }, [flush]);

  const update = (patch: Partial<BrandTemplate>) => {
    const base = latest.current;
    if (!base) return;
    const next = { ...base, ...patch } as BrandTemplate;
    latest.current = next;
    dirty.current = true;
    setTemplate(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 700);
  };

  const star = async () => {
    if (!template) return;
    const updated = await setDefaultTemplate(template.id, siblings);
    setSiblings(updated);
    const next = { ...(updated.find((t) => t.id === template.id) ?? template), default: true };
    latest.current = next;
    setTemplate(next);
    toast("This is now your usual look", "ok");
  };

  if (!id || missing) {
    return (
      <div className="rr-card rr-enter mx-auto mt-10 max-w-md px-6 py-12 text-center">
        <p className="rr-h3">We can&apos;t find that brand look</p>
        <p className="mt-1 text-sm text-ink-faint">It may have been deleted.</p>
        <Link href="/brands" className="rr-btn rr-btn-primary mt-5">
          Back to Brands
        </Link>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rr-card rr-enter mx-auto mt-10 max-w-md px-6 py-12 text-center">
        <TriangleAlert className="mx-auto h-6 w-6 text-danger" />
        <p className="rr-h3 mt-3">We couldn&apos;t open this brand look</p>
        <p className="mt-1 text-sm text-ink-faint">{loadError}</p>
        <button type="button" className="rr-btn rr-btn-primary mt-5" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  if (!template) {
    return (
      <div className="space-y-5" aria-busy="true" aria-label="Opening the brand look">
        <div className="rr-skeleton h-9 w-72 max-w-full" />
        <div className="rr-skeleton h-10 w-full max-w-md" />
        <div className="rr-skeleton h-[420px] w-full" />
      </div>
    );
  }

  const logo = template.logo;
  const music = template.music;
  const layout = template.layout ?? { mode: "auto", aspect: "9:16" };
  const cleanup = template.cleanup ?? { filler_policy: "smart", silence_policy: "tighten", mode: "natural" };

  return (
    <div className="mx-auto max-w-[1180px]">
      <Link href="/brands" className="rr-btn rr-btn-ghost rr-btn-sm -ml-2">
        <ArrowLeft className="h-3.5 w-3.5" />
        All brand looks
      </Link>

      <header className="rr-enter mt-3 flex flex-wrap items-center justify-between gap-3">
        <input
          className="rr-input max-w-md flex-1 border-transparent bg-transparent px-1 font-display text-[2rem] font-semibold leading-tight tracking-[-0.025em]"
          style={{ height: "auto" }}
          value={template.name}
          aria-label="Brand look name"
          onChange={(e) => update({ name: e.target.value })}
        />
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[12px] text-ink-faint" aria-live="polite">
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
              </>
            ) : saveError ? (
              <span className="text-danger">Not saved — {saveError}</span>
            ) : savedAt ? (
              <>
                <Check className="h-3.5 w-3.5 text-ready" /> Saved · version {revision}
              </>
            ) : (
              <>Version {revision}</>
            )}
          </span>
          {template.default ? (
            <span className="flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-[12px] text-accent">
              <Star className="h-3 w-3" />
              Usual look
            </span>
          ) : (
            <button type="button" className="rr-btn rr-btn-sm" onClick={() => void star()}>
              <Star className="h-3.5 w-3.5" />
              Make this my usual look
            </button>
          )}
        </div>
      </header>

      <nav className="rr-enter mt-5 flex flex-wrap gap-1.5" style={{ animationDelay: "60ms" }}>
        {TABS.map((t) => (
          <button key={t.key} type="button" className="rr-chip" data-active={tab === t.key ? "true" : "false"} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="mt-6 space-y-6">
        {tab === "captions" && (
          <>
            <CaptionDesigner style={resolveCaptionStyle(template.captions)} onChange={(captions) => update({ captions })} />
            <SampleRender style={resolveCaptionStyle(template.captions)} projects={projects} />
          </>
        )}

        {tab === "look" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <AssetField
              label="Logo"
              hint="A PNG with a see-through background works best."
              kind="image"
              assetKind="logo"
              accept="image/*"
              templateId={template.id}
              path={logo?.path}
              onChange={(path) => update({ logo: path ? { corner: "tr", height: 96, opacity: 0.9, ...(logo ?? {}), path } : undefined })}
            >
              {logo?.path && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="rr-field">
                    <label htmlFor="rr-logo-corner">Corner</label>
                    <select id="rr-logo-corner" className="rr-select rr-select-sm" value={logo.corner ?? "tr"} onChange={(e) => update({ logo: { ...logo, corner: e.target.value } })}>
                      {CORNERS.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="rr-field">
                    <label htmlFor="rr-logo-height">Size {logo.height ?? 96}</label>
                    <input id="rr-logo-height" type="range" min={40} max={260} value={logo.height ?? 96} onChange={(e) => update({ logo: { ...logo, height: Number(e.target.value) } })} className="w-full accent-[color:var(--rr-accent)]" />
                  </div>
                  <div className="rr-field">
                    <label htmlFor="rr-logo-opacity">Strength {Math.round((logo.opacity ?? 0.9) * 100)}%</label>
                    <input
                      id="rr-logo-opacity"
                      type="range"
                      min={10}
                      max={100}
                      value={Math.round((logo.opacity ?? 0.9) * 100)}
                      onChange={(e) => update({ logo: { ...logo, opacity: Number(e.target.value) / 100 } })}
                      className="w-full accent-[color:var(--rr-accent)]"
                    />
                  </div>
                </div>
              )}
            </AssetField>

            <div className="rr-card space-y-4 p-4">
              <div className="rr-field">
                <label htmlFor="rr-headline">Headline</label>
                <input id="rr-headline" className="rr-input" placeholder="The Long Game" value={template.headline?.text ?? ""} onChange={(e) => update({ headline: e.target.value ? { text: e.target.value } : undefined })} />
                <p className="text-[12px] text-ink-faint">Shown on the opening card of a full episode.</p>
              </div>
              <div className="rr-field">
                <label htmlFor="rr-cta">Closing line</label>
                <input id="rr-cta" className="rr-input" placeholder="Follow for more" value={template.cta?.text ?? ""} onChange={(e) => update({ cta: e.target.value ? { text: e.target.value } : undefined })} />
                <p className="text-[12px] text-ink-faint">Shown on the end card.</p>
              </div>
            </div>
          </div>
        )}

        {tab === "sound" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <AssetField
              label="Intro"
              hint="Plays before the episode."
              kind="video"
              assetKind="intro"
              accept="video/*"
              templateId={template.id}
              path={template.intro?.path}
              onChange={(path) => update({ intro: path ? { path } : undefined })}
            />
            <AssetField
              label="Outro"
              hint="Plays after the episode."
              kind="video"
              assetKind="outro"
              accept="video/*"
              templateId={template.id}
              path={template.outro?.path}
              onChange={(path) => update({ outro: path ? { path } : undefined })}
            />
            <AssetField
              label="Background music"
              hint="Ducked under the talking."
              kind="audio"
              assetKind="music"
              accept="audio/*"
              templateId={template.id}
              path={music?.path}
              onChange={(path) => update({ music: path ? { gain_db: -18, duck_db: -12, fade_ms: 1500, ...(music ?? {}), path } : undefined })}
            >
              {music?.path && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="rr-field">
                    <label htmlFor="rr-music-gain">Level {music.gain_db ?? -18}</label>
                    <input id="rr-music-gain" type="range" min={-40} max={0} value={music.gain_db ?? -18} onChange={(e) => update({ music: { ...music, gain_db: Number(e.target.value) } })} className="w-full accent-[color:var(--rr-accent)]" />
                  </div>
                  <div className="rr-field">
                    <label htmlFor="rr-music-duck">Under the voice {music.duck_db ?? -12}</label>
                    <input id="rr-music-duck" type="range" min={-40} max={0} value={music.duck_db ?? -12} onChange={(e) => update({ music: { ...music, duck_db: Number(e.target.value) } })} className="w-full accent-[color:var(--rr-accent)]" />
                  </div>
                  <div className="rr-field">
                    <label htmlFor="rr-music-fade">Fade {Math.round((music.fade_ms ?? 1500) / 100) / 10}s</label>
                    <input id="rr-music-fade" type="range" min={0} max={5000} step={100} value={music.fade_ms ?? 1500} onChange={(e) => update({ music: { ...music, fade_ms: Number(e.target.value) } })} className="w-full accent-[color:var(--rr-accent)]" />
                  </div>
                </div>
              )}
            </AssetField>
          </div>
        )}

        {tab === "defaults" && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rr-card space-y-4 p-4">
              <h3 className="rr-h3">Framing</h3>
              <div className="rr-field">
                <label htmlFor="rr-layout-mode">How clips are framed</label>
                <select id="rr-layout-mode" className="rr-select" value={layout.mode ?? "auto"} onChange={(e) => update({ layout: { ...layout, mode: e.target.value } })}>
                  {LAYOUT_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rr-field">
                <label htmlFor="rr-layout-aspect">Shape</label>
                <select id="rr-layout-aspect" className="rr-select" value={layout.aspect ?? "9:16"} onChange={(e) => update({ layout: { ...layout, aspect: e.target.value } })}>
                  {ASPECT_RATIOS.map((a) => (
                    <option key={a} value={a}>
                      {ASPECT_LABELS[a] ?? a}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="rr-card space-y-4 p-4">
              <h3 className="rr-h3">Tidying</h3>
              <div className="rr-field">
                <label htmlFor="rr-filler">Filler words</label>
                <select id="rr-filler" className="rr-select" value={cleanup.filler_policy ?? "smart"} onChange={(e) => update({ cleanup: { ...cleanup, filler_policy: e.target.value } })}>
                  {FILLER_POLICIES.map((p) => (
                    <option key={p} value={p}>
                      {FILLER_LABELS[p] ?? p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rr-field">
                <label htmlFor="rr-silence">Pauses</label>
                <select id="rr-silence" className="rr-select" value={cleanup.silence_policy ?? "tighten"} onChange={(e) => update({ cleanup: { ...cleanup, silence_policy: e.target.value } })}>
                  {SILENCE_POLICIES.map((p) => (
                    <option key={p} value={p}>
                      {SILENCE_LABELS[p] ?? p}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rr-field">
                <label htmlFor="rr-mode">Length</label>
                <select id="rr-mode" className="rr-select" value={cleanup.mode ?? "natural"} onChange={(e) => update({ cleanup: { ...cleanup, mode: e.target.value } })}>
                  {DURATION_MODES.map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m] ?? m}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-[12px] text-ink-faint">These are the starting points when you use this look. You can still change them on any clip or episode.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
