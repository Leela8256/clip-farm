"use client";

import { useState } from "react";
import { Check, Palette } from "lucide-react";
import { CAPTION_GALLERY, captionCss, captionHighlightCss, type BrandTemplate, type CaptionPresetCard } from "@/lib/brand";
import { CLIP_ASPECTS } from "./clip-style";

/** The words on the little sample line, chosen so every look shows its shape. */
const SAMPLE = ["THIS", "IS", "HOW", "IT"];
const SAMPLE_HOT = "LOOKS";

function Sample({ card, compact }: { card: CaptionPresetCard; compact?: boolean }) {
  if (card.id === "none") {
    return <span className="text-[11px] text-white/45">no captions</span>;
  }
  const style = captionCss(card.style);
  const words = compact ? SAMPLE.slice(2) : SAMPLE;
  return (
    <span style={style} className="inline-block max-w-full">
      {words.join(" ")} <span style={captionHighlightCss(card.style)}>{SAMPLE_HOT}</span>
    </span>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="rr-label shrink-0" title={hint}>
        {label}
      </span>
      <div className="flex min-w-0 items-center justify-end gap-1.5">{children}</div>
    </div>
  );
}

/**
 * How this one clip looks: the caption gallery, a saved brand, and the shape
 * the tall version is made in. Every control here reaches the render — nothing
 * on this panel is decoration.
 */
export default function StylePanel({
  galleryId,
  aspect,
  templates,
  templateId,
  templatesError,
  disabled,
  onPickCaptions,
  onPickAspect,
  onApplyTemplate,
}: {
  galleryId: string;
  aspect: string;
  templates: BrandTemplate[] | null;
  /** the template last stamped into this clip */
  templateId: string | null;
  templatesError: string | null;
  disabled?: boolean;
  onPickCaptions: (card: CaptionPresetCard) => void;
  onPickAspect: (aspect: string) => void;
  onApplyTemplate: (template: BrandTemplate) => void;
}) {
  const current = CAPTION_GALLERY.find((c) => c.id === galleryId) ?? CAPTION_GALLERY[1];

  return (
    <div className={`space-y-2.5 ${disabled ? "pointer-events-none opacity-60" : ""}`}>
      <Row label="Brand" hint="A saved look — logo, captions, framing — stamped onto this clip">
        {templatesError ? (
          <span className="text-[12px] text-processing" title={templatesError}>
            couldn&apos;t load your brands
          </span>
        ) : templates && templates.length === 0 ? (
          <span className="text-[12px] text-ink-faint">none saved yet</span>
        ) : (
          <select
            value={templateId ?? ""}
            onChange={(e) => {
              const t = (templates ?? []).find((x) => x.id === e.target.value);
              if (t) onApplyTemplate(t);
            }}
            disabled={!templates}
            className="rr-select rr-select-sm w-44"
            aria-label="Brand"
          >
            <option value="">{templates ? "no brand" : "loading…"}</option>
            {(templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.default ? " (default)" : ""}
              </option>
            ))}
          </select>
        )}
      </Row>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="rr-label">Captions</span>
          <span className="text-[11px] text-ink-faint">{current.hint}</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Caption looks">
          {CAPTION_GALLERY.map((card) => {
            const active = card.id === current.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => onPickCaptions(card)}
                aria-pressed={active}
                title={card.hint}
                className={`overflow-hidden rounded-md border text-left transition-colors ${active ? "border-accent ring-1 ring-accent/40" : "border-line hover:border-line-strong"}`}
              >
                <span className="flex h-[44px] items-end justify-center bg-ink px-1 pb-1">
                  <Sample card={card} compact />
                </span>
                <span className="flex items-center gap-1 px-1.5 py-1">
                  {active && <Check className="h-3 w-3 shrink-0 text-accent" />}
                  <span className="min-w-0 truncate text-[11px] text-ink">{card.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <Row label="Shape" hint="The shape of the tall version. The wide 16:9 export is unchanged.">
        <div className="flex flex-wrap items-center justify-end gap-1">
          {CLIP_ASPECTS.map((a) => (
            <button key={a.value} type="button" onClick={() => onPickAspect(a.value)} data-active={aspect === a.value} className="rr-chip h-7 px-2.5 text-[12px]" title={a.hint}>
              {a.value}
            </button>
          ))}
        </div>
      </Row>
    </div>
  );
}
