import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import type { JobEvent, Transcript, Edl } from "@/lib/types";

/**
 * Exercises the exact WebSocket event -> UI state logic in EditorPage,
 * including the chat-mode "ready" status regression found in manual E2E
 * testing (the terminal handler used to treat any non-"done" status as a
 * failure, so chat mode always rendered the error screen instead of the
 * editing workspace).
 */

let emit: (event: JobEvent) => void;
const watchJobMock = vi.fn((jobId: string, onEvent: (e: JobEvent) => void) => {
  emit = onEvent;
  return () => {};
});

const sampleTranscript: Transcript = {
  language: "en",
  duration_sec: 10,
  segments: [{ id: 0, text: "hello", start_ms: 0, end_ms: 1000, words: [] }],
};

const sampleEdl: Edl = {
  job_id: "job1",
  source_file: "x.mp3",
  total_duration_ms: 10000,
  created_at: "now",
  edits: [],
  keep_segments: [{ start_ms: 0, end_ms: 10000 }],
  stats: { total_cuts: 0, total_cut_ms: 0, output_duration_ms: 10000 },
};

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("job=job1&mode=chat"),
}));

vi.mock("@/lib/api", () => ({
  api: {
    transcript: vi.fn(() => Promise.resolve(sampleTranscript)),
    edl: vi.fn(() => Promise.resolve(sampleEdl)),
    chat: vi.fn(),
    render: vi.fn(),
    downloadUrl: (id: string) => `/api/download/${id}`,
    previewUrl: (id: string) => `/api/preview/${id}`,
  },
  watchJob: watchJobMock,
  fmtMs: (ms: number) => `${Math.floor(ms / 1000)}s`,
}));

// WaveformPlayer pulls in wavesurfer.js (needs canvas APIs jsdom lacks), and
// TranscriptEditor/EdlPanel/ChatPanel are exercised by their own component
// tests — mock all four here so this test stays focused on page-level status
// logic (the WebSocket event -> UI state transitions).
vi.mock("@/components/editor/WaveformPlayer", () => ({
  default: () => <div data-testid="waveform" />,
}));
vi.mock("@/components/editor/TranscriptEditor", () => ({
  default: () => <div data-testid="transcript-editor" />,
}));
vi.mock("@/components/editor/EdlPanel", () => ({
  default: () => <div data-testid="edl-panel" />,
}));
vi.mock("@/components/chat/ChatPanel", () => ({
  default: () => <div data-testid="chat-panel" />,
}));

const EditorPageWrapper = (await import("../page")).default;

describe("EditorPage — WebSocket status handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("chat mode: 'ready' terminal loads the editing workspace, not an error screen", async () => {
    render(<EditorPageWrapper />);

    emit({ type: "terminal", status: "ready" });

    await waitFor(() => {
      expect(screen.queryByText(/pipeline failed/i)).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("waveform")).toBeInTheDocument();
    });
  });

  it("'error' terminal shows the failure screen", async () => {
    render(<EditorPageWrapper />);

    emit({ type: "terminal", status: "error" });

    await waitFor(() => {
      expect(screen.getByText("Pipeline failed")).toBeInTheDocument();
    });
  });

  it("'done' terminal shows the download screen", async () => {
    render(<EditorPageWrapper />);

    emit({ type: "terminal", status: "done", final_file: "final.mp3" });

    await waitFor(() => {
      expect(screen.getByText(/episode ready/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute(
      "href",
      "/api/download/job1"
    );
  });

  it("a snapshot reconnecting to an already-'ready' job also loads the workspace", async () => {
    render(<EditorPageWrapper />);

    emit({ type: "snapshot", status: "ready", stage: null, error: null, final_file: null });

    await waitFor(() => {
      expect(screen.getByTestId("waveform")).toBeInTheDocument();
    });
  });

  it("stage events update the loading label without erroring", async () => {
    render(<EditorPageWrapper />);

    emit({ type: "stage", stage: "transcribing" });

    await waitFor(() => {
      expect(screen.getByText(/transcribing audio/i)).toBeInTheDocument();
    });
  });
});
