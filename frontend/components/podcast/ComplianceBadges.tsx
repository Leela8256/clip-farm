"use client";

import type { complianceBadges } from "@/lib/director";

type Badge = ReturnType<typeof complianceBadges>[number];

const TONE: Record<Badge["tone"], string> = {
  ok: "border-ready/40 bg-ready/10 text-ready",
  warn: "border-processing/40 bg-processing/10 text-processing",
  bad: "border-danger/40 bg-danger/10 text-danger",
  muted: "border-line text-ink-faint",
};

/** The verdict chips (prompt match, length, speaker, topic, faces…) as one wrapping row. */
export default function ComplianceBadges({ badges, className = "" }: { badges: Badge[]; className?: string }) {
  if (badges.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {badges.map((b) => (
        <span key={b.label} className={`rounded-full border px-2 py-0.5 font-mono text-[11px] leading-4 ${TONE[b.tone]}`}>
          {b.label}
        </span>
      ))}
    </div>
  );
}
