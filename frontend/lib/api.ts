import type { Transcript, Edl, ChatMessage, TaskStatus, Mode } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

export const api = {
  async upload(file: File): Promise<{ job_id: string; audio_path: string }> {
    const form = new FormData();
    form.append("file", file);
    return json(await fetch("/api/upload", { method: "POST", body: form }));
  },

  async startJob(job_id: string, audio_path: string, mode: Mode): Promise<{ task_id: string }> {
    return json(
      await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id, audio_path, mode }),
      })
    );
  },

  async taskStatus(task_id: string): Promise<TaskStatus> {
    return json(await fetch(`/api/tasks/${task_id}/status`));
  },

  async transcript(job_id: string): Promise<Transcript> {
    return json(await fetch(`/api/jobs/${job_id}/transcript`));
  },

  async edl(job_id: string): Promise<Edl> {
    return json(await fetch(`/api/jobs/${job_id}/edl`));
  },

  async chat(
    job_id: string,
    message: string,
    history: ChatMessage[]
  ): Promise<{ assistant_message: string; edl: Edl; chat_history: ChatMessage[] }> {
    return json(
      await fetch(`/api/chat/${job_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, chat_history: history }),
      })
    );
  },

  async render(job_id: string): Promise<{ task_id: string }> {
    return json(await fetch(`/api/jobs/${job_id}/render`, { method: "POST" }));
  },

  downloadUrl: (job_id: string) => `/api/download/${job_id}`,
  previewUrl: (job_id: string) => `/api/preview/${job_id}`,
};

export function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
