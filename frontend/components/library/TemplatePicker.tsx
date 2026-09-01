"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Palette } from "lucide-react";
import type { BrandTemplate } from "@/lib/brand";
import { Modal } from "./Modal";

/** Pick the look a recording's clips start from. Nothing is re-rendered here. */
export default function TemplatePicker({
  templates,
  current,
  title,
  onApply,
  onClose,
}: {
  templates: BrandTemplate[] | null;
  current?: string;
  title: string;
  onApply: (templateId: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const choose = async (id: string | null) => {
    setBusy(id ?? "none");
    try {
      await onApply(id);
      onClose();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Use a brand look" subtitle={title} onClose={onClose} width="520px">
      {templates === null ? (
        <div className="space-y-2">
          <div className="rr-skeleton h-12 w-full" />
          <div className="rr-skeleton h-12 w-full" />
        </div>
      ) : templates.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-ink">You haven&apos;t made a brand look yet</p>
          <p className="mt-1 text-[13px] text-ink-faint">A brand look holds your logo, caption style, intro and outro.</p>
          <Link href="/brands" className="rr-btn rr-btn-primary mt-4" onClick={onClose}>
            <Palette className="h-4 w-4 text-accent" />
            Make one
          </Link>
        </div>
      ) : (
        <ul className="space-y-2">
          {templates.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void choose(t.id)}
                className={`flex w-full items-center gap-3 rounded-[14px] border px-3 py-2.5 text-left transition-colors ${
                  current === t.id ? "border-accent bg-accent/5" : "border-line hover:bg-surface-overlay"
                }`}
              >
                <Palette className="h-4 w-4 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">{t.name}</span>
                  <span className="block truncate text-[12px] text-ink-faint">
                    {[t.captions?.preset ? `${t.captions.preset.replace(/-/g, " ")} captions` : "", t.logo?.path ? "logo" : "", t.music?.path ? "music" : "", t.intro?.path ? "intro" : ""]
                      .filter(Boolean)
                      .join(" · ") || "Nothing set yet"}
                  </span>
                </span>
                {busy === t.id ? <span className="text-[12px] text-ink-faint">Applying…</span> : current === t.id ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
              </button>
            </li>
          ))}
          {current && (
            <li>
              <button type="button" disabled={!!busy} onClick={() => void choose(null)} className="w-full rounded-[14px] border border-line px-3 py-2.5 text-left text-[13px] text-ink-dim hover:bg-surface-overlay">
                Use no brand look
              </button>
            </li>
          )}
        </ul>
      )}
    </Modal>
  );
}
