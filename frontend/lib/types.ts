export interface Word {
  word: string;
  start_ms: number;
  end_ms: number;
  probability: number;
}

export interface TranscriptSegment {
  id: number;
  text: string;
  start_ms: number;
  end_ms: number;
  words: Word[];
}

export interface Transcript {
  language: string;
  duration_sec: number;
  segments: TranscriptSegment[];
}

export interface Edit {
  id: string;
  type: "cut";
  start_ms: number;
  end_ms: number;
  reason: string;
  source: "auto" | "agent" | "user";
}

export interface Edl {
  job_id: string;
  source_file: string;
  total_duration_ms: number;
  created_at: string;
  edits: Edit[];
  keep_segments: { start_ms: number; end_ms: number }[];
  stats: {
    total_cuts: number;
    total_cut_ms: number;
    output_duration_ms: number;
  };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TaskStatus {
  task_id: string;
  state: "PENDING" | "PROGRESS" | "SUCCESS" | "FAILURE";
  stage?: string;
  result?: { final_file?: string };
  error?: string;
}

export type Mode = "autopilot" | "chat";

export type JobEvent =
  | { type: "snapshot"; status: string; stage: string | null; error: string | null; final_file: string | null }
  | { type: "stage"; stage: string }
  | { type: "terminal"; status: string; final_file?: string };
