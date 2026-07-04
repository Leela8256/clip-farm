"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, Loader2, Scissors } from "lucide-react";
import { api, fmtMs } from "@/lib/api";
import type { Transcript, Edl, ChatMessage, TaskStatus, Mode } from "@/lib/types";
import TranscriptEditor from "@/components/editor/TranscriptEditor";
import EdlPanel from "@/components/editor/EdlPanel";
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
  const initialTask = params.get("task") ?? "";
  const mode = (params.get("mode") ?? "autopilot") as Mode;

  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [edl, setEdl] = useState<Edl | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [renderTask, setRenderTask] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const activeTask = renderTask ?? initialTask;

  // Poll task status
  useEffect(() => {
    if (!activeTask || done) return;
    const iv = setInterval(async () => {
      const s = await api.taskStatus(activeTask);
      setStatus(s);
      if (s.state === "SUCCESS") {
        if (mode === "autopilot" || renderTask) {
          setDone(true);
        }
        // chat mode: transcription finished, load transcript + edl
        try {
          setTranscript(await api.transcript(jobId));
          setEdl(await api.edl(jobId));
        } catch {}
        clearInterval(iv);
      }
      if (s.state === "FAILURE") clearInterval(iv);
    }, 2500);
    return () => clearInterval(iv);
  }, [activeTask, jobId, mode, renderTask, done]);

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
    const { task_id } = await api.render(jobId);
    setRenderTask(task_id);
    setDone(false);
  }, [jobId]);

  // ── render states ──────────────────────────────────────

  if (status?.state === "FAILURE") {
    return (
      <div className="rounded-lg border border-cut/40 bg-cut/10 p-6 text-sm">
        <p className="font-medium text-cut">Pipeline failed</p>
        <p className="mt-2 font-mono text-xs text-ink-dim">{status.error}</p>
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

  const processing =
    !status || status.state === "PENDING" || status.state === "PROGRESS";

  if (processing && (mode === "autopilot" || !transcript)) {
    const label = status?.stage ? STAGE_LABELS[status.stage] ?? status.stage : "Starting";
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
        <audio controls src={api.previewUrl(jobId)} className="w-full" />
        {transcript && edl && (
          <TranscriptEditor transcript={transcript} edl={edl} />
        )}
      </div>
      <div className="space-y-6">
        {edl && (
          <EdlPanel
            edl={edl}
            onRender={onRender}
            rendering={!!renderTask && !done}
            stage={renderTask ? status?.stage : undefined}
          />
        )}
        <ChatPanel history={history} onSend={onChat} />
      </div>
    </div>
  );
}
