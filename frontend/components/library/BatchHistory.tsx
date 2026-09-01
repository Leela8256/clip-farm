"use client";

import Link from "next/link";
import { ArrowRight, History } from "lucide-react";
import type { Batch } from "@/lib/batch";

const when = (seconds?: number) => (seconds ? new Date(seconds * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

/** Past group runs — one sentence sent to several recordings at once. */
export default function BatchHistory({ batches, names }: { batches: Batch[] | null; names: Map<string, string> }) {
  if (batches === null) return <div className="rr-skeleton h-16 w-full" />;
  if (batches.length === 0) return null;

  return (
    <section className="mt-10">
      <h2 className="rr-eyebrow flex items-center gap-2">
        <History className="h-3.5 w-3.5" />
        Earlier group runs
      </h2>
      <ul className="mt-3 space-y-2">
        {batches.map((b) => {
          const delivered = b.projects.reduce((n, p) => n + (p.delivered ?? 0), 0);
          const failed = b.projects.filter((p) => p.status === "failed").length;
          const open = b.projects.filter((p) => p.status === "queued" || p.status === "running").length;
          return (
            <li key={b.id} className="rr-card p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="min-w-0 flex-1 truncate text-[14px] text-ink" title={b.prompt}>
                  “{b.prompt}”
                </p>
                <p className="font-mono text-[11px] text-ink-faint">{when(b.created)}</p>
              </div>
              <p className="mt-1 text-[12px] text-ink-dim">
                {b.projects.length} {b.projects.length === 1 ? "recording" : "recordings"} · {delivered} {delivered === 1 ? "clip" : "clips"}
                {failed ? ` · ${failed} didn’t work` : ""}
                {open ? ` · ${open} unfinished` : ""}
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {b.projects.map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/episode?id=${encodeURIComponent(p.id)}`}
                      className={`rr-chip ${p.status === "failed" ? "border-danger/40 text-danger" : ""}`}
                      title={p.status === "failed" ? p.error || "Didn’t work" : `${p.delivered ?? 0} clips`}
                    >
                      <span className="max-w-[180px] truncate">{names.get(p.id) ?? p.id}</span>
                      {p.status === "done" && <span className="font-mono text-[11px] text-ink-faint">{p.delivered ?? 0}</span>}
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
