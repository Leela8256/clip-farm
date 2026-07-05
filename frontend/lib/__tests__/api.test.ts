import { describe, it, expect } from "vitest";
import { fmtMs } from "@/lib/api";

describe("fmtMs", () => {
  it("formats zero", () => {
    expect(fmtMs(0)).toBe("0:00");
  });

  it("pads seconds under 10", () => {
    expect(fmtMs(5_000)).toBe("0:05");
  });

  it("formats minutes and seconds", () => {
    expect(fmtMs(125_000)).toBe("2:05");
  });

  it("truncates partial seconds", () => {
    expect(fmtMs(59_999)).toBe("0:59");
  });

  it("formats durations over an hour as minutes", () => {
    // fmtMs doesn't special-case hours — matches existing player displays
    expect(fmtMs(3_661_000)).toBe("61:01");
  });
});
