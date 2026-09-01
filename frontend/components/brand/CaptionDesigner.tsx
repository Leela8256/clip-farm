"use client";

import { useState } from "react";
import { CAPTION_GALLERY, captionsOff, galleryIdOf, type CaptionStyle } from "@/lib/brand";
import CaptionSample from "./CaptionSample";

const FONTS = [
  { value: "", label: "Standard" },
  { value: "DejaVu Sans", label: "DejaVu Sans (clean)" },
  { value: "DejaVu Serif", label: "DejaVu Serif (editorial)" },
  { value: "Liberation Sans", label: "Liberation Sans (neutral)" },
  { value: "Noto Sans", label: "Noto Sans (wide language support)" },
];

const WEIGHTS: { value: NonNullable<CaptionStyle["weight"]>; label: string }[] = [
  { value: "normal", label: "Regular" },
  { value: "bold", label: "Bold" },
  { value: "black", label: "Extra bold" },
];

const POSITIONS: { value: NonNullable<CaptionStyle["position"]>; label: string }[] = [
  { value: "bottom", label: "Low" },
  { value: "middle", label: "Middle" },
  { value: "top", label: "High" },
];

function Swatch({ label, value, fallback, onChange }: { label: string; value?: string; fallback: string; onChange: (v: string) => void }) {
  return (
    <div className="rr-field">
      <label>{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value ?? fallback}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          aria-label={label}
          className="h-[38px] w-[52px] cursor-pointer rounded-[10px] border border-line-strong bg-surface-raised p-1"
        />
        <span className="font-mono text-[11px] text-ink-faint">{(value ?? fallback).toUpperCase()}</span>
      </div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1.5">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--rr-accent)]" />
      <span className="min-w-0">
        <span className="block text-[13px] text-ink">{label}</span>
        {hint && <span className="block text-[12px] text-ink-faint">{hint}</span>}
      </span>
    </label>
  );
}

function Slider({ label, value, min, max, step = 1, suffix = "", onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <div className="rr-field">
      <label>
        {label} <span className="font-mono text-ink-dim">{`${value}${suffix}`}</span>
      </label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="w-full accent-[color:var(--rr-accent)]" />
    </div>
  );
}

/**
 * The caption studio: pick a look from the gallery, then tune every part of it
 * and watch it change. Shared by the brand editor and the clip workbench.
 */
export default function CaptionDesigner({ style, onChange, compact = false }: { style: CaptionStyle; onChange: (style: CaptionStyle) => void; compact?: boolean }) {
  const [portrait, setPortrait] = useState(false);
  const [openControls, setOpenControls] = useState(!compact);
  const set = (patch: Partial<CaptionStyle>) => onChange({ ...style, ...patch });

  const outline = style.outline ?? { width: 4, color: "#000000" };
  const box = style.box;
  const off = captionsOff(style);
  const active = galleryIdOf(style);

  const gallery = (
    <ul className={compact ? "flex gap-2 overflow-x-auto pb-1" : "grid grid-cols-2 gap-2.5 sm:grid-cols-3"}>
      {CAPTION_GALLERY.map((p) => {
        const picked = active === p.id;
        return (
          <li key={p.id} className={compact ? "w-[132px] shrink-0" : ""}>
            <button
              type="button"
              onClick={() => onChange({ ...p.style, preset: p.id })}
              aria-pressed={picked}
              title={p.hint}
              className={`w-full overflow-hidden rounded-[14px] border p-1.5 text-left transition-colors ${picked ? "border-accent bg-accent/5" : "border-line hover:border-line-strong hover:bg-surface-overlay"}`}
            >
              <CaptionSample style={p.style} text="Words that sell the clip" animate={!compact} className="w-full" />
              <span className="mt-1.5 block truncate px-0.5 text-[12px] font-medium text-ink">{p.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  const preview = (
    <div className={compact ? "" : "rr-card p-3"}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="rr-eyebrow">Live look</p>
        <span className="flex gap-1">
          <button type="button" className="rr-chip" data-active={!portrait ? "true" : "false"} onClick={() => setPortrait(false)}>
            Wide
          </button>
          <button type="button" className="rr-chip" data-active={portrait ? "true" : "false"} onClick={() => setPortrait(true)}>
            Tall
          </button>
        </span>
      </div>
      <CaptionSample style={style} portrait={portrait} className="w-full" />
      <p className="mt-2 text-[12px] text-ink-faint">
        {off ? "Captions are off for this look — clips go out with no words on screen." : "A picture of the style. The words are burned into the clip when you make it."}
      </p>
    </div>
  );

  const controls = (
    <div className="space-y-5">
      <section>
        <p className="rr-eyebrow">Letters</p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div className="rr-field">
            <label htmlFor="rr-cap-font">Font</label>
            <select id="rr-cap-font" className="rr-select" value={style.font ?? ""} onChange={(e) => set({ font: e.target.value || undefined })}>
              {FONTS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="rr-field">
            <label htmlFor="rr-cap-weight">Thickness</label>
            <select id="rr-cap-weight" className="rr-select" value={style.weight ?? "bold"} onChange={(e) => set({ weight: e.target.value as CaptionStyle["weight"] })}>
              {WEIGHTS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </div>
          <Slider label="Size" value={style.size ?? 64} min={32} max={110} onChange={(v) => set({ size: v })} />
          <div className="rr-field">
            <label htmlFor="rr-cap-case">Capitals</label>
            <select id="rr-cap-case" className="rr-select" value={style.case ?? "none"} onChange={(e) => set({ case: e.target.value as CaptionStyle["case"] })}>
              <option value="none">As spoken</option>
              <option value="upper">ALL CAPS</option>
            </select>
          </div>
        </div>
        <p className="mt-1 text-[12px] text-ink-faint">If a font isn&apos;t available where the clip is made, the standard one is used instead.</p>
      </section>

      <section>
        <p className="rr-eyebrow">Colour</p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <Swatch label="Words" value={style.color} fallback="#FFFFFF" onChange={(v) => set({ color: v })} />
          <Swatch label="Highlight" value={style.highlight_color} fallback="#FF6B4A" onChange={(v) => set({ highlight_color: v })} />
          <Slider label="Edge" value={outline.width} min={0} max={10} suffix="px" onChange={(v) => set({ outline: { ...outline, width: v } })} />
          <Swatch label="Edge colour" value={outline.color} fallback="#000000" onChange={(v) => set({ outline: { ...outline, color: v } })} />
        </div>
        <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
          <Toggle label="Soft drop shadow" checked={!!style.shadow} onChange={(v) => set({ shadow: v })} />
          <Toggle
            label="Panel behind the words"
            checked={!!box}
            onChange={(v) => set({ box: v ? { color: "#000000", opacity: 0.75 } : undefined })}
          />
        </div>
        {box && (
          <div className="mt-1 grid grid-cols-2 gap-3">
            <Swatch label="Panel colour" value={box.color} fallback="#000000" onChange={(v) => set({ box: { ...box, color: v } })} />
            <Slider label="Panel strength" value={Math.round((box.opacity ?? 0.75) * 100)} min={10} max={100} suffix="%" onChange={(v) => set({ box: { ...box, opacity: v / 100 } })} />
          </div>
        )}
      </section>

      <section>
        <p className="rr-eyebrow">Placing</p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div className="rr-field">
            <label htmlFor="rr-cap-position">Height on screen</label>
            <select id="rr-cap-position" className="rr-select" value={style.position ?? "bottom"} onChange={(e) => set({ position: e.target.value as CaptionStyle["position"] })}>
              {POSITIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="rr-field">
            <label htmlFor="rr-cap-align">Line-up</label>
            <select id="rr-cap-align" className="rr-select" value={style.alignment ?? "center"} onChange={(e) => set({ alignment: e.target.value as CaptionStyle["alignment"] })}>
              <option value="center">Centred</option>
              <option value="left">Left</option>
            </select>
          </div>
          <Slider label="Words per line" value={style.max_words ?? 4} min={1} max={8} onChange={(v) => set({ max_words: v })} />
          <div className="rr-field">
            <label htmlFor="rr-cap-lines">Lines at once</label>
            <select id="rr-cap-lines" className="rr-select" value={String(style.max_lines ?? 1)} onChange={(e) => set({ max_lines: e.target.value === "2" ? 2 : 1 })}>
              <option value="1">One</option>
              <option value="2">Two</option>
            </select>
          </div>
        </div>
      </section>

      <section>
        <p className="rr-eyebrow">Movement</p>
        <div className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
          <Toggle label="Light up each word as it is said" checked={style.karaoke !== false} onChange={(v) => set({ karaoke: v })} />
          <Toggle label="Pop the word being said" checked={!!style.emphasis} onChange={(v) => set({ emphasis: v })} />
          <Toggle label="A colour per speaker" hint="Applies once your episode has speakers named." checked={!!style.speaker_colors} onChange={(v) => set({ speaker_colors: v })} />
        </div>
        <div className="rr-field mt-2">
          <label htmlFor="rr-cap-keywords">Always highlight these words</label>
          <input
            id="rr-cap-keywords"
            className="rr-input"
            placeholder="growth, money, secret"
            value={(style.keywords ?? []).join(", ")}
            onChange={(e) =>
              set({
                keywords: e.target.value
                  .split(",")
                  .map((w) => w.trim())
                  .filter(Boolean),
              })
            }
          />
        </div>
      </section>
    </div>
  );

  if (compact) {
    return (
      <div className="space-y-3">
        {gallery}
        {preview}
        <button type="button" className="rr-btn rr-btn-sm w-full" onClick={() => setOpenControls((v) => !v)}>
          {openControls ? "Hide the fine tuning" : "Fine-tune this look"}
        </button>
        {openControls && controls}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <section>
          <p className="rr-eyebrow">Start from a look</p>
          <div className="mt-2">{gallery}</div>
        </section>
        {controls}
      </div>
      <div className="xl:sticky xl:top-6 xl:self-start">{preview}</div>
    </div>
  );
}
