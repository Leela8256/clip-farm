"use client";

import { useEffect, useState } from "react";
import { Film } from "lucide-react";
import { mediaUrl } from "@/lib/engine";

/**
 * A still from the project — the newest rendered thumbnail we have — with a
 * shimmer while it loads and a film icon when there is nothing to show yet.
 * (Folded in from the old history row so the library has one thumbnail.)
 */
export default function ProjectThumb({ path, version = 0, className = "" }: { path?: string | null; version?: number; className?: string }) {
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
    <div className={`relative overflow-hidden bg-surface-overlay ${loading ? "rr-skeleton" : ""} ${className}`}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="rr-enter h-full w-full object-cover" />
      ) : (
        !loading && (
          <div className="flex h-full w-full items-center justify-center text-ink-faint">
            <Film className="h-5 w-5" />
          </div>
        )
      )}
    </div>
  );
}
