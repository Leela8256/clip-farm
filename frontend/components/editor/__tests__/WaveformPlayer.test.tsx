import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { Edl } from "@/lib/types";

/**
 * WaveSurfer needs canvas/AudioContext APIs jsdom doesn't implement, so both
 * it and the regions plugin are mocked. The mock captures enough of the real
 * lifecycle (event registration, ready firing, destroy) to verify the
 * component's own logic: it doesn't draw regions before "ready" fires, it
 * redraws (clear + re-add) on every EDL change, and it cleans up on unmount.
 */

const regionsInstance = {
  clearRegions: vi.fn(),
  addRegion: vi.fn(),
};

let readyCallback: (() => void) | null = null;
const wsInstance = {
  on: vi.fn((event: string, cb: () => void) => {
    if (event === "ready") readyCallback = cb;
  }),
  load: vi.fn(),
  destroy: vi.fn(),
  getDuration: vi.fn(() => 10),
  playPause: vi.fn(),
};

vi.mock("wavesurfer.js", () => ({
  default: { create: vi.fn(() => wsInstance) },
}));
vi.mock("wavesurfer.js/dist/plugins/regions.esm.js", () => ({
  default: { create: vi.fn(() => regionsInstance) },
}));

const WaveformPlayer = (await import("../WaveformPlayer")).default;

function makeEdl(edits: Edl["edits"]): Edl {
  return {
    job_id: "j",
    source_file: "x.mp3",
    total_duration_ms: 10000,
    created_at: "now",
    edits,
    keep_segments: [],
    stats: { total_cuts: edits.length, total_cut_ms: 0, output_duration_ms: 10000 },
  };
}

describe("WaveformPlayer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readyCallback = null;
  });

  it("does not draw regions before the player is ready", () => {
    const edl = makeEdl([{ id: "e1", type: "cut", start_ms: 1000, end_ms: 2000, reason: "x", source: "auto" }]);
    render(<WaveformPlayer src="a.mp3" edl={edl} />);

    expect(regionsInstance.addRegion).not.toHaveBeenCalled();
  });

  it("draws one region per EDL edit once ready", () => {
    const edl = makeEdl([
      { id: "e1", type: "cut", start_ms: 1000, end_ms: 2000, reason: "x", source: "auto" },
      { id: "e2", type: "cut", start_ms: 5000, end_ms: 6000, reason: "y", source: "agent" },
    ]);
    render(<WaveformPlayer src="a.mp3" edl={edl} />);

    act(() => readyCallback?.());

    expect(regionsInstance.clearRegions).toHaveBeenCalled();
    expect(regionsInstance.addRegion).toHaveBeenCalledTimes(2);
    expect(regionsInstance.addRegion).toHaveBeenCalledWith(
      expect.objectContaining({ start: 1, end: 2 })
    );
  });

  it("redraws (clear + re-add) when the EDL changes after a chat edit", () => {
    const edl1 = makeEdl([{ id: "e1", type: "cut", start_ms: 1000, end_ms: 2000, reason: "x", source: "auto" }]);
    const { rerender } = render(<WaveformPlayer src="a.mp3" edl={edl1} />);
    act(() => readyCallback?.());
    expect(regionsInstance.addRegion).toHaveBeenCalledTimes(1);

    const edl2 = makeEdl([
      { id: "e1", type: "cut", start_ms: 1000, end_ms: 2000, reason: "x", source: "auto" },
      { id: "e2", type: "cut", start_ms: 3000, end_ms: 4000, reason: "agent cut", source: "agent" },
    ]);
    rerender(<WaveformPlayer src="a.mp3" edl={edl2} />);

    expect(regionsInstance.clearRegions).toHaveBeenCalledTimes(2);
    expect(regionsInstance.addRegion).toHaveBeenCalledTimes(3); // 1 + 2
  });

  it("shows a cut count badge only when there are edits", () => {
    const { rerender } = render(<WaveformPlayer src="a.mp3" edl={makeEdl([])} />);
    expect(screen.queryByText(/cuts? shown in red/)).not.toBeInTheDocument();

    rerender(
      <WaveformPlayer
        src="a.mp3"
        edl={makeEdl([{ id: "e1", type: "cut", start_ms: 0, end_ms: 1000, reason: "x", source: "auto" }])}
      />
    );
    expect(screen.getByText(/1 cut shown in red/)).toBeInTheDocument();
  });

  it("destroys the wavesurfer instance on unmount", () => {
    const { unmount } = render(<WaveformPlayer src="a.mp3" edl={null} />);
    unmount();
    expect(wsInstance.destroy).toHaveBeenCalledTimes(1);
  });

  it("disables the play button until ready", () => {
    render(<WaveformPlayer src="a.mp3" edl={null} />);
    expect(screen.getByRole("button", { name: /play/i })).toBeDisabled();

    act(() => readyCallback?.());
    expect(screen.getByRole("button", { name: /play/i })).not.toBeDisabled();
  });
});
