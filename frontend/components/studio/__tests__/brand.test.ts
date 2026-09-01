import { describe, expect, it } from "vitest";
import { emptyEdits, type EpisodeEdits } from "@/lib/studio";
import type { BrandTemplate } from "@/lib/brand";
import { applyBrand } from "../brand";
import { qualityLine, qualityOf } from "../helpers";

const template = (): BrandTemplate => ({
  schema_version: 1,
  id: "night",
  name: "Night Show",
  created: 1,
  updated: 1,
  revision: 3,
  logo: { path: "brand-templates/night/assets/logo.png", corner: "bl", height: 0.12, opacity: 0.8 },
  headline: { text: "The Night Show" },
  cta: { text: "Subscribe" },
  music: { path: "brand-templates/night/assets/bed.mp3", gain_db: -20, duck_db: -14, fade_ms: 1200 },
  layout: { mode: "auto", aspect: "9:16" },
  captions: { preset: "bold-impact", color: "#FFEE00", position: "middle", karaoke: true },
});

const base = (): EpisodeEdits => emptyEdits(600_000, 1_000);

describe("applying a brand to an episode", () => {
  it("fills in the blanks and reaches the edit record", () => {
    const result = applyBrand(base(), template());
    expect(result.edits.assets.logo?.path).toBe("brand-templates/night/assets/logo.png");
    expect(result.edits.assets.logo?.corner).toBe("bl");
    expect(result.edits.assets.title_card?.text).toBe("The Night Show");
    expect(result.edits.assets.end_card?.text).toBe("Subscribe");
    expect(result.edits.assets.music?.duck_db).toBe(-14);
    expect(result.edits.extra_aspects).toContain("9:16");
    expect(result.edits.visual.caption_style.color).toBe("#FFEE00");
    expect(result.edits.visual.caption_style.position).toBe("middle");
    expect(result.brand.revision).toBe(3);
    expect(result.filled).toContain("logo");
  });

  it("never overwrites what the producer chose", () => {
    const mine = base();
    mine.assets.logo = { path: "projects/e1/assets/logo.png", corner: "tr", height: 0.1, opacity: 0.9 };
    mine.assets.title_card = { text: "My own card", seconds: 3 };
    mine.visual.caption_style = { ...mine.visual.caption_style, color: "#FF0000", position: "top" };
    const result = applyBrand(mine, template());
    expect(result.edits.assets.logo?.path).toBe("projects/e1/assets/logo.png");
    expect(result.edits.assets.title_card?.text).toBe("My own card");
    expect(result.edits.visual.caption_style.color).toBe("#FF0000");
    expect(result.edits.visual.caption_style.position).toBe("top");
    // the untouched parts still come from the brand
    expect(result.edits.visual.caption_style.karaoke).toBe(true);
    expect(result.kept).toContain("logo");
    expect(result.kept).toContain("opening card");
  });

  it("leaves the recording and the cuts alone", () => {
    const mine = base();
    const result = applyBrand(mine, template());
    expect(result.edits.operations).toBe(mine.operations);
    expect(result.edits.source_duration_ms).toBe(mine.source_duration_ms);
  });
});

describe("how a made version came out", () => {
  it("reads the quality block a render reports", () => {
    const line = qualityLine(qualityOf({ quality: { tier: "standard", width: 1280, height: 720, fps: 30, audio_channels: 2 } }));
    expect(line).toBe("1280×720 · 30 fps · stereo");
  });

  it("falls back to the plain numbers an older report carries", () => {
    expect(qualityLine(qualityOf({ quality: "rough", width: 640, height: 360 }))).toBe("640×360");
  });

  it("says nothing when nothing was measured", () => {
    expect(qualityLine(qualityOf({ quality: "rough" }))).toBe("");
  });
});
