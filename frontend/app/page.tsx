"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { UploadCloud, Wand2, MessageSquare, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { Mode } from "@/lib/types";

export default function UploadPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("autopilot");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const { job_id, audio_path } = await api.upload(file);
        await api.startJob(job_id, audio_path, mode);
        router.push(`/editor?job=${job_id}&mode=${mode}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
        setBusy(false);
      }
    },
    [mode, router]
  );

  return (
    <div className="mx-auto max-w-2xl pt-12">
      <p className="font-mono text-xs uppercase tracking-[0.14em] text-ink-faint">
        New episode
      </p>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-[-0.02em]">
        Edit a podcast episode
      </h1>
      <p className="mt-2 text-ink-dim">
        Upload raw audio. Choose how it gets edited.
      </p>

      <div className="mt-8 grid grid-cols-2 gap-3">
        <ModeCard
          active={mode === "autopilot"}
          onClick={() => setMode("autopilot")}
          icon={<Wand2 className="h-5 w-5" />}
          title="Auto-pilot"
          desc="Fully automatic: silence and filler cleanup, noise reduction, mastering, intro/outro."
        />
        <ModeCard
          active={mode === "chat"}
          onClick={() => setMode("chat")}
          icon={<MessageSquare className="h-5 w-5" />}
          title="Chat editing"
          desc="Talk to the editor agent. Review every cut before rendering."
        />
      </div>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) handleFile(file);
        }}
        className={`mt-6 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 transition-colors ${
          dragging
            ? "border-accent bg-accent/5"
            : "border-line-strong bg-surface-raised hover:border-ink-faint"
        }`}
      >
        {busy ? (
          <Loader2 className="h-8 w-8 animate-spin text-accent" />
        ) : (
          <UploadCloud className="h-8 w-8 text-ink-faint" />
        )}
        <div className="text-sm text-ink-dim">
          {busy ? "Uploading and starting pipeline…" : "Drop audio here, or click to browse"}
        </div>
        <div className="font-mono text-xs text-ink-faint">
          MP3, WAV, M4A, FLAC — up to 500MB
        </div>
        <input
          type="file"
          accept=".mp3,.wav,.m4a,.flac,.ogg,.aac"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </label>

      {error && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/15 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border p-4 text-left transition-colors ${
        active
          ? "border-accent bg-accent/5"
          : "border-line bg-surface-raised hover:border-line-strong hover:bg-surface-overlay"
      }`}
    >
      <div className={`flex items-center gap-2 ${active ? "text-accent" : "text-ink-dim"}`}>
        {icon}
        <span className="font-medium text-ink">{title}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-dim">{desc}</p>
    </button>
  );
}
