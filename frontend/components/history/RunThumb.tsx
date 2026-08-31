"use client";

import { useEffect, useState } from "react";
import { Film } from "lucide-react";
import { mediaUrl } from "@/lib/engine";

/** A 96×54 thumbnail from your library, a shimmer while it loads, a film icon when there is none. */
export default function RunThumb({ path, version = 0 }: { path?: string | null; version?: number }) {
  const [loaded, setLoaded] = useState<{ path: string; url: string | null } | null>(null);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    mediaUrl(path, version)
      .then((url) => {
        if (!cancelled) setLoaded({ path, url });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ path, url: null });
      });
    return () => {
      cancelled = true;
    };
  }, [path, version]);

  const url = path && loaded?.path === path ? loaded.url : null;
  const loading = !!path && loaded?.path !== path;

  return (
    <div className={`relative h-[54px] w-24 shrink-0 overflow-hidden rounded-[8px] bg-surface-overlay ${loading ? "rr-skeleton" : ""}`} style={{ borderRadius: 8 }}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="rr-enter h-full w-full object-cover" />
      ) : (
        !loading && (
          <div className="flex h-full w-full items-center justify-center text-ink-faint">
            <Film className="h-4 w-4" />
          </div>
        )
      )}
    </div>
  );
}
