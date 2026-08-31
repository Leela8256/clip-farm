"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";

export type ToastTone = "ok" | "info" | "warn";

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

const listeners = new Set<(t: Toast) => void>();
let seq = 0;

/** Show a short bottom-right notification from anywhere in the app. */
export function toast(message: string, tone: ToastTone = "info"): void {
  const t = { id: ++seq, message, tone };
  listeners.forEach((fn) => fn(t));
}

const ICONS = { ok: CheckCircle2, info: Info, warn: TriangleAlert } as const;
const TONES = { ok: "text-ready", info: "text-ink", warn: "text-danger" } as const;

export default function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    const add = (t: Toast) => {
      setItems((prev) => [...prev.slice(-3), t]);
      timers.set(
        t.id,
        setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), t.tone === "warn" ? 7000 : 3500)
      );
    };
    listeners.add(add);
    return () => {
      listeners.delete(add);
      timers.forEach((h) => clearTimeout(h));
    };
  }, []);

  if (!items.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-2">
      {items.map((t) => {
        const Icon = ICONS[t.tone];
        return (
          <div key={t.id} className="rr-enter pointer-events-auto flex items-start gap-2.5 rounded-md border border-line bg-surface-raised px-3.5 py-2.5 text-sm shadow-elev-2">
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONES[t.tone]}`} />
            <span className="flex-1 leading-snug text-ink">{t.message}</span>
            <button type="button" aria-label="dismiss" onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))} className="rounded p-0.5 text-ink-faint hover:text-ink">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
