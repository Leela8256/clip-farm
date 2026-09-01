"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Copy, Palette, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import { getClient, getConnectionState, subscribeConnection } from "@/lib/engine";
import { createTemplate, deleteTemplate, duplicateTemplate, listTemplates, resolveCaptionStyle, setDefaultTemplate, type BrandTemplate } from "@/lib/brand";
import CaptionSample from "@/components/brand/CaptionSample";
import { ConfirmDialog, TextDialog } from "@/components/library/Modal";
import { toast } from "@/components/shell/Toasts";

const serverState = () => "idle" as const;

export default function BrandsPage() {
  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, serverState);
  const [templates, setTemplates] = useState<BrandTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<BrandTemplate | null>(null);

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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await listTemplates());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connection !== "connected") return;
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [connection, refresh]);

  const add = async (name: string) => {
    const made = await createTemplate(name);
    setTemplates((prev) => [...(prev ?? []), made]);
    toast("Brand look created", "ok");
  };

  const copy = async (t: BrandTemplate) => {
    const made = await duplicateTemplate(t);
    setTemplates((prev) => [...(prev ?? []), made]);
    toast(`Copied “${t.name}”`, "ok");
  };

  const star = async (t: BrandTemplate) => {
    setTemplates(await setDefaultTemplate(t.id, templates ?? [t]));
    toast(`“${t.name}” is your usual look`, "ok");
  };

  const remove = async () => {
    if (!deleting) return;
    await deleteTemplate(deleting.id, deleting);
    setTemplates((prev) => (prev ?? []).filter((x) => x.id !== deleting.id));
    toast("Brand look deleted", "ok");
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <header className="rr-enter flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="rr-h1">Brands</h1>
          <p className="mt-2 text-ink-dim">Your logo, caption look, intro and outro — saved once, used on every clip and episode.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void refresh()} disabled={connection !== "connected" || loading} aria-label="Refresh" className="rr-btn rr-btn-ghost rr-btn-icon">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button type="button" className="rr-btn rr-btn-primary rr-btn-sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5 text-accent" />
            New brand look
          </button>
        </div>
      </header>

      <div className="mt-7">
        {templates === null ? (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="rr-card overflow-hidden">
                <div className="rr-skeleton aspect-video w-full" style={{ borderRadius: 0 }} />
                <div className="space-y-2 p-4">
                  <div className="rr-skeleton h-4 w-1/2" />
                  <div className="rr-skeleton h-3 w-2/3" />
                </div>
              </li>
            ))}
          </ul>
        ) : templates.length === 0 ? (
          <div className="rr-card rr-enter flex flex-col items-center px-6 py-14 text-center">
            <Palette className="h-6 w-6 text-ink-faint" />
            <p className="mt-3 text-lg font-medium text-ink">No brand looks yet</p>
            <p className="mt-1 max-w-md text-[13px] text-ink-faint">
              A brand look keeps your captions, logo, intro, outro and music together so every clip comes out looking like you.
            </p>
            <button type="button" className="rr-btn rr-btn-primary mt-5" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4 text-accent" />
              Make your first one
            </button>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((t, i) => (
              <li key={t.id} className="rr-enter" style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}>
                <div className="rr-card rr-card-hover flex h-full flex-col overflow-hidden">
                  <Link href={`/brand?id=${encodeURIComponent(t.id)}`} className="block p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                    <CaptionSample style={resolveCaptionStyle(t.captions)} text="Your words, your look" animate={false} className="w-full" />
                  </Link>
                  <div className="flex flex-1 flex-col gap-2 px-4 pb-4 pt-1">
                    <div className="flex items-center gap-2">
                      <Link href={`/brand?id=${encodeURIComponent(t.id)}`} className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink hover:underline" title={t.name}>
                        {t.name}
                      </Link>
                      {t.default && (
                        <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                          <Star className="h-3 w-3" />
                          Usual
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[12px] text-ink-faint">
                      {[t.logo?.path ? "logo" : "", t.intro?.path ? "intro" : "", t.outro?.path ? "outro" : "", t.music?.path ? "music" : "", t.cta?.text ? "call to action" : ""]
                        .filter(Boolean)
                        .join(" · ") || "Captions only"}
                    </p>
                    <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                      <Link href={`/brand?id=${encodeURIComponent(t.id)}`} className="rr-btn rr-btn-sm flex-1">
                        Open
                      </Link>
                      <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm rr-btn-icon" title="Make a copy" aria-label={`Copy ${t.name}`} onClick={() => void copy(t)}>
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      {!t.default && (
                        <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm rr-btn-icon" title="Make this my usual look" aria-label={`Make ${t.name} the usual look`} onClick={() => void star(t)}>
                          <Star className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm rr-btn-icon" title="Delete" aria-label={`Delete ${t.name}`} onClick={() => setDeleting(t)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {connection === "error" && templates === null && <p className="mt-4 text-center text-[13px] text-ink-faint">Still connecting — your brand looks appear as soon as the dot in the sidebar turns green.</p>}
      </div>

      {creating && <TextDialog title="New brand look" label="Name" placeholder="Main show" confirmLabel="Create" onSubmit={add} onClose={() => setCreating(false)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete “${deleting.name}”?`}
          body="The look and the files you added to it are removed. Clips you already made keep the look they were made with."
          confirmLabel="Delete it"
          onConfirm={remove}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
