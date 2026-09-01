"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Clapperboard, LibraryBig, Palette, PanelLeftClose, PanelLeftOpen, Scissors, Upload } from "lucide-react";
import { getClient, getConnectionState, reconnect, subscribeConnection } from "@/lib/engine";
import { recentEpisodes, subscribeRecent, type RecentEpisode } from "@/lib/recent";

const serverConnection = () => "idle" as const;
const noRecent: RecentEpisode[] = [];
const serverRecent = () => noRecent;

let recentCache: RecentEpisode[] = noRecent;
let recentKey = "";
function readRecent(): RecentEpisode[] {
  const list = recentEpisodes();
  const key = list.map((e) => e.id).join("|");
  if (key !== recentKey) {
    recentKey = key;
    recentCache = list;
  }
  return recentCache;
}

export default function Sidebar() {
  const pathname = usePathname();
  const params = useSearchParams();
  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, serverConnection);
  const recent = useSyncExternalStore(subscribeRecent, readRecent, serverRecent);
  const [collapsed, setCollapsed] = useState(false);

  // The shell owns the connection: open it once on mount, and keep retrying
  // while the very first attempt fails (the service started after the page).
  useEffect(() => {
    const timer = setTimeout(() => void getClient().catch(() => {}), 0);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (connection !== "error") return;
    const timer = setInterval(() => void getClient().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [connection]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("clipfarm.sidebar");
      if (saved === "collapsed") {
        const t = setTimeout(() => setCollapsed(true), 0);
        return () => clearTimeout(t);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("clipfarm.sidebar", c ? "open" : "collapsed");
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  const currentEpisode = pathname === "/episode" || pathname === "/studio" ? params.get("id") : null;
  const target = (route: string) => (currentEpisode ? `${route}?id=${encodeURIComponent(currentEpisode)}` : recent[0] ? `${route}?id=${encodeURIComponent(recent[0].id)}` : "/projects");
  const items = [
    { href: "/", label: "New episode", icon: Upload, active: pathname === "/" },
    { href: "/projects", label: "My Projects", icon: LibraryBig, active: pathname === "/projects" || pathname === "/history" },
    { href: target("/episode"), label: "Create Clips", icon: Scissors, active: pathname === "/episode" },
    { href: target("/studio"), label: "Episode Editor", icon: Clapperboard, active: pathname === "/studio" },
    { href: "/brands", label: "Brands", icon: Palette, active: pathname === "/brands" || pathname === "/brand" },
  ];
  const online = connection === "connected";

  return (
    <aside
      data-collapsed={collapsed ? "true" : "false"}
      className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-line bg-surface-raised/80 backdrop-blur transition-[width] duration-200 ${collapsed ? "w-[64px]" : "w-[232px]"}`}
    >
      <div className={`flex items-center ${collapsed ? "justify-center" : "justify-between"} px-3 pt-4`}>
        <Link href="/" className="flex items-center gap-2.5" title="Clip Farm">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-ink text-ink-inverse">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 10h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <path d="M4 6l16-3 1 4-17 3z" />
              <path d="M10 14v4l4-2z" />
            </svg>
          </span>
          {!collapsed && <span className="font-display text-lg font-semibold tracking-[-0.02em]">Clip Farm</span>}
        </Link>
        {!collapsed && (
          <button type="button" onClick={toggle} aria-label="collapse navigation" className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-overlay hover:text-ink">
            <PanelLeftClose className="h-4 w-4" />
          </button>
        )}
      </div>
      {collapsed && (
        <button type="button" onClick={toggle} aria-label="expand navigation" className="mx-auto mt-3 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-overlay hover:text-ink">
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      )}

      <nav className="mt-6 flex flex-col gap-1 px-2">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <Link
              key={it.label}
              href={it.href}
              title={it.label}
              aria-current={it.active ? "page" : undefined}
              className={`group flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-all duration-150 ${collapsed ? "justify-center" : ""} ${
                it.active ? "bg-ink text-ink-inverse shadow-elev-1" : "text-ink-dim hover:bg-surface-overlay hover:text-ink"
              }`}
            >
              <Icon className={`h-4 w-4 shrink-0 ${it.active ? "text-accent" : "text-ink-faint group-hover:text-ink"}`} />
              {!collapsed && <span className="font-medium">{it.label}</span>}
            </Link>
          );
        })}
      </nav>

      {!collapsed && recent.length > 0 && (
        <div className="mt-7 px-3">
          <p className="rr-eyebrow px-1.5">Recent</p>
          <ul className="mt-2 space-y-0.5">
            {recent.slice(0, 5).map((e) => (
              <li key={e.id}>
                <Link
                  href={`/episode?id=${encodeURIComponent(e.id)}`}
                  className={`block truncate rounded-md px-2 py-1.5 text-[13px] transition-colors ${currentEpisode === e.id ? "bg-surface-overlay text-ink" : "text-ink-dim hover:bg-surface-overlay hover:text-ink"}`}
                  title={e.title}
                >
                  {e.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          if (!online) void reconnect().catch(() => {});
        }}
        className={`mt-auto flex items-center gap-2 px-4 py-4 text-[11px] text-ink-faint transition-colors hover:text-ink ${collapsed ? "justify-center px-0" : ""}`}
        title={online ? "Connected" : connection === "connecting" ? "Connecting…" : "Offline — click to retry"}
      >
        <span className={`h-2 w-2 rounded-full ${online ? "rr-dot-live bg-ready" : connection === "connecting" ? "bg-processing" : "bg-danger"}`} />
        {!collapsed && <span>{online ? "Online" : connection === "connecting" ? "Connecting…" : "Offline · retry"}</span>}
      </button>
    </aside>
  );
}
