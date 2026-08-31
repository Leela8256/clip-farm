"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { CONNECTION_LOST_MESSAGE, getClient, getConnectionState, isConnectionError, runAnalysis, runKey, startRun, subscribeConnection, uploadFile, writeJson } from "@/lib/engine";
import { episodeIdFor, prettyTitle, projectRoot, safeName, type Project } from "@/lib/podcast";
import { rememberEpisode } from "@/lib/recent";
import { toast } from "@/components/shell/Toasts";
import NewEpisodeForm, { type NewEpisodeInput, type UploadPhase } from "@/components/podcast/NewEpisodeForm";

const serverState = () => "idle" as const;

/** Error text a producer can act on (the SDK's own messages name the machinery). */
function plainError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (message === CONNECTION_LOST_MESSAGE || isConnectionError(message)) {
    return "The connection dropped. Wait for the dot in the sidebar to turn green, then try again.";
  }
  return message || "Something went wrong. Please try again.";
}

export default function HomePage() {
  const router = useRouter();
  const connection = useSyncExternalStore(subscribeConnection, getConnectionState, serverState);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Open the connection on arrival and keep knocking while it is down.
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

  const create = async (input: NewEpisodeInput) => {
    setError(null);
    setPhase("uploading");
    setPercent(0);
    const id = episodeIdFor(input.file.name);
    const root = projectRoot(id);
    const title = prettyTitle(input.file.name);
    try {
      const source = await uploadFile(`${root}/source/${safeName(input.file.name)}`, input.file, (sent, total) => setPercent(Math.round((sent / total) * 100)));
      setPhase("creating");
      const project: Project = {
        episode_id: id,
        title,
        source,
        created: Date.now() / 1000,
        settings: { goal: input.goal, clip_count: input.clipCount, min_seconds: input.minSeconds, max_seconds: input.maxSeconds },
        analysis: { status: "analyzing", started_at: Date.now() / 1000 },
      };
      await writeJson(`${root}/project.json`, project);
      startRun(runKey(id), "analysis", (onProgress) => runAnalysis(id, input.goal, onProgress));
      rememberEpisode(id, title);
      router.push(`/episode?id=${encodeURIComponent(id)}`);
    } catch (e) {
      const message = plainError(e);
      setError(message);
      toast(message, "warn");
      setPhase("idle");
    }
  };

  return (
    <div className="mx-auto max-w-3xl pt-6 sm:pt-12 lg:pt-20">
      <section className="rr-enter text-center">
        <h1 className="rr-display text-balance">
          Find the <span className="rr-underline">moments</span>. Cut the clips. Ship them.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg text-ink-dim">Drop in a full episode and get back the short clips worth posting.</p>
      </section>

      <div className="rr-enter mt-10 sm:mt-12" style={{ animationDelay: "90ms" }}>
        <NewEpisodeForm busy={phase !== "idle"} phase={phase} percent={percent} canRun={connection === "connected"} error={error} onSubmit={(input) => void create(input)} />
      </div>
    </div>
  );
}
