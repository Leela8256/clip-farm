"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import { mediaUrl } from "@/lib/engine";
import { uploadTemplateAsset, type BrandAssetKind } from "@/lib/brand";

type Kind = "image" | "video" | "audio";

/** One piece of branding: choose a file, see it, or take it away again. */
export default function AssetField({
  label,
  hint,
  kind,
  assetKind,
  accept,
  path,
  templateId,
  onChange,
  children,
}: {
  label: string;
  hint?: string;
  kind: Kind;
  assetKind: BrandAssetKind;
  accept: string;
  path?: string;
  templateId: string;
  onChange: (path: string | undefined) => void;
  children?: React.ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState<{ path: string; url: string | null } | null>(null);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    mediaUrl(path)
      .then((u) => {
        if (!cancelled) setLoaded({ path, url: u });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ path, url: null });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const url = path && loaded?.path === path ? loaded.url : null;

  const pick = async (file: File) => {
    setError("");
    setProgress(0);
    try {
      const saved = await uploadTemplateAsset(templateId, assetKind, file, (sent, total) => setProgress(total ? sent / total : 0));
      onChange(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  const fileName = path ? path.split("/").pop() : "";

  return (
    <div className="rr-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">{label}</p>
          {hint && <p className="text-[12px] text-ink-faint">{hint}</p>}
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button type="button" className="rr-btn rr-btn-sm" onClick={() => input.current?.click()} disabled={progress !== null}>
            <Upload className="h-3.5 w-3.5" />
            {path ? "Replace" : "Choose"}
          </button>
          {path && (
            <button type="button" className="rr-btn rr-btn-ghost rr-btn-sm rr-btn-icon" onClick={() => onChange(undefined)} aria-label={`Remove ${label}`}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void pick(file);
        }}
      />

      {progress !== null && (
        <div className="mt-2">
          <div className="rr-progress">
            <i style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="mt-1 text-[12px] text-ink-faint">Sending… {Math.round(progress * 100)}%</p>
        </div>
      )}

      {path && (
        <div className="mt-2">
          <p className="truncate font-mono text-[11px] text-ink-faint" title={fileName}>
            {fileName}
          </p>
          {url && kind === "image" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={label} className="mt-2 max-h-24 rounded-md bg-surface-overlay object-contain p-2" />
          )}
          {url && kind === "video" && <video src={url} controls playsInline className="mt-2 max-h-40 w-full rounded-md bg-black" />}
          {url && kind === "audio" && <audio src={url} controls className="mt-2 w-full" />}
        </div>
      )}

      {children && <div className="mt-3">{children}</div>}
      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
