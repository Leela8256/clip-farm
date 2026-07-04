"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, Loader2, Scissors } from "lucide-react";
import { api, watchJob } from "@/lib/api";
import type { Transcript, Edl, ChatMessage, Mode, JobEvent } from "@/lib/types";
import TranscriptEditor from "@/components/editor/TranscriptEditor";
import EdlPanel from "@/components/editor/EdlPanel";
import WaveformPlayer from "@/components/editor/WaveformPlayer";
import ChatPanel from "@/components/chat/ChatPanel";

const STAGE_LABELS: Record<string, string> = {
  transcribing: "Transcribing audio",
  auto_cleanup: "Detecting silences and fillers",
  rendering: "Rendering edits with crossfades",
  mastering: "Mastering — noise reduction and loudness",
  brand_merge: "Adding intro and outro",
};

export default function EditorPageWrapper() {
  return (
    <Suspense>
      <EditorPage />
    </Suspense>
  );
}

function EditorPage() {
  const params = useSearchParams();
  const jobId = params.get("job") ?? "";
  const mode = (params.get("mode") ?? "autopilot") as Mode;

  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [edl, setEdl] = useState<Edl | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [rendering, setRendering] = useState(false);
  const [done, setDone] = useState(false);

  // Live job status via WebSocket — replaces polling GET /api/tasks/{id}/status
  useEffect(() => {
    if (!jobId) return;

    const handleEvent = async (event: JobEvent) => {
      if (event.type === "snapshot") {
        setJobStatus(event.status);
        setStage(event.stage);
        setError(event.error);
        if (event.status === "done") setDone(true);
      } else if (event.type === "stage") {
        setStage(event.stage);
        setJobStatus("running");
      } else if (event.type === "terminal") {
        setJobStatus(event.status);
        if (event.status === "done") {
          if (mode === "autopilot" || rendering) setDone(true);
          try {
            setTranscript(await api.transcript(jobId));
            setEdl(await api.edl(jobId));
          } catch {}
        }
        if (event.status !== "done") setError(event.status);
      }
    };

    return watchJob(jobId, handleEvent);
  }, [jobId, mode, rendering]);

  const onChat = useCallback(
    async (message: string) => {
      const res = await api.chat(jobId, message, history);
      setHistory(res.chat_history);
      setEdl(res.edl);
      return res.assistant_message;
    },
    [jobId, history]
  );

  const onRender = useCallback(async () => {
    await api.render(jobId);
    setRendering(true);
    setDone(false);
  }, [jobId]);

  // ── render states ──────────────────────────────────────

  if (error) {
    return (
      <div className="rounded-lg border border-cut/40 bg-cut/10 p-6 text-sm">
        <p className="font-medium text-cut">Pipeline failed</p>
        <p className="mt-2 font-mono text-xs text-ink-dim">{error}</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto max-w-xl pt-16 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-keep/15">
          <Scissors className="h-6 w-6 text-keep" />
        </div>
        <h1 className="mt-6 text-xl font-semibold">Episode ready</h1>
        <p className="mt-2 text-sm text-ink-dim">
          Mastered to -16 LUFS, intro and outro added, exported as MP3.
        </p>
        <a
          href={api.downloadUrl(jobId)}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white hover:bg-accent-dim"
        >
          <Download className="h-4 w-4" /> Download final.mp3
        </a>
      </div>
    );
  }

  const processing = jobStatus === null || jobStatus === "pending" || jobStatus === "running";

  if (processing && (mode === "autopilot" || !transcript)) {
    const label = stage ? STAGE_LABELS[stage] ?? stage : "Starting";
    return (
      <div className="mx-auto max-w-xl pt-24 text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-accent" />
        <p className="mt-4 text-sm text-ink-dim">{label}…</p>
        <p className="mt-1 font-mono text-xs text-ink-faint">job {jobId}</p>
      </div>
    );
  }

  // Chat editing workspace
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        <WaveformPlayer src={api.previewUrl(jobId)} edl={edl} />
        {transcript && edl && (
          <TranscriptEditor transcript={transcript} edl={edl} />
        )}
      </div>
      <div className="space-y-6">
        {edl && (
          <EdlPanel
            edl={edl}
            onRender={onRender}
            rendering={rendering && !done}
            stage={rendering ? stage ?? undefined : undefined}
          />
        )}
        <ChatPanel history={history} onSend={onChat} />
      </div>
    </div>
  );
}
