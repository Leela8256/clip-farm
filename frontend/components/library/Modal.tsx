"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

/**
 * A centred panel over a dim backdrop. Escape and a click on the backdrop
 * close it; the panel itself scrolls when the screen is short.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = "560px",
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const first = panel.current?.querySelector<HTMLElement>("input, textarea, select, button");
    const timer = setTimeout(() => first?.focus(), 30);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" onClick={onClose} className="fixed inset-0 cursor-default" style={{ background: "var(--rr-overlay)" }} />
      <div ref={panel} className="rr-card rr-enter relative my-auto w-full overflow-hidden" style={{ maxWidth: width, boxShadow: "var(--rr-shadow-2)" }}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="rr-h3 truncate">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-faint">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rr-btn rr-btn-ghost rr-btn-icon shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-overlay/50 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** "Are you sure?" — the destructive action is never one click away. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  tone = "danger",
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  tone?: "danger" | "normal";
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      width="440px"
      footer={
        <>
          <button type="button" className="rr-btn" onClick={onClose} disabled={busy}>
            Keep it
          </button>
          <button
            type="button"
            className={`rr-btn ${tone === "danger" ? "rr-btn-accent" : "rr-btn-primary"}`}
            onClick={() => void go()}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-[14px] text-ink-dim">{body}</p>
    </Modal>
  );
}

/** One short line of text — used for renaming a project or a collection. */
export function TextDialog({
  title,
  label,
  initial,
  placeholder,
  confirmLabel = "Save",
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit: (value: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const text = value.trim();
    if (!text) return;
    setBusy(true);
    try {
      await onSubmit(text);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      width="440px"
      footer={
        <>
          <button type="button" className="rr-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rr-btn rr-btn-primary" onClick={() => void go()} disabled={busy || !value.trim()}>
            {busy ? "Saving…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="rr-field">
        <label htmlFor="rr-text-dialog">{label}</label>
        <input
          id="rr-text-dialog"
          className="rr-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void go();
            }
          }}
        />
      </div>
    </Modal>
  );
}
