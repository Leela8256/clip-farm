"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Plug } from "lucide-react";
import { ENGINE_URI, getClient, getConnectionError, getConnectionState, reconnect, subscribeConnection } from "@/lib/engine";

const serverState = () => "idle" as const;
const serverError = () => null;

/** Live engine connection pill. Connects on mount and keeps retrying if the engine goes away. */
export default function EngineBadge() {
  const state = useSyncExternalStore(subscribeConnection, getConnectionState, serverState);
  const error = useSyncExternalStore(subscribeConnection, getConnectionError, serverError);

  useEffect(() => {
    const timer = setTimeout(() => void getClient().catch(() => {}), 0);
    return () => clearTimeout(timer);
  }, []);

  // The SDK reconnects by itself after a drop; this only covers the case where the
  // very first connection never succeeded (engine started after the page loaded).
  useEffect(() => {
    if (state !== "error") return;
    const timer = setInterval(() => void getClient().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [state]);

  const host = ENGINE_URI.replace(/^https?:\/\//, "");
  const label =
    state === "connected" ? `engine ${host}` : state === "error" ? "engine offline" : state === "connecting" && error ? "reconnecting to engine…" : "connecting to engine…";
  return (
    <span
      title={error ?? undefined}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-raised px-2.5 py-0.5 font-mono text-[11px] text-ink-dim"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          state === "connected" ? "bg-ready" : state === "error" ? "bg-danger" : "bg-processing animate-pulse"
        }`}
      />
      {label}
      {state === "error" && (
        <button type="button" onClick={() => void reconnect()} aria-label="Retry connection" className="ml-1 text-ink hover:text-accent">
          <Plug className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
