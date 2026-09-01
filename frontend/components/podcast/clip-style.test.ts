import { describe, expect, it } from "vitest";
import { applyTemplate, effectiveRender, previewBehindEdits, renderSignature, styleOf, type StyledEdit } from "./clip-style";
import { emptyTemplate, resolveBrand, type BrandTemplate } from "@/lib/brand";
import type { ClipPlan, RequestSpec } from "@/lib/director";

const spec = (over: Partial<RequestSpec> = {}): RequestSpec => ({
  spec_version: 1,
  count: 3,
  duration: { target_seconds: 42, min_seconds: null, max_seconds: null, mode: "natural" },
  speakers: [],
  subjects: [],
  exclude_subjects: [],
  exclude_content: [],
  tone: null,
  hook: null,
  ending: null,
  filler_policy: "smart",
  silence_policy: "tighten",
  caption_preset: "classic",
  aspect_ratio: "9:16",
  platform: null,
  warnings: [],
  ...over,
});

const RANGE = { start_ms: 1000, end_ms: 41_000 };

/** A plan as the renderer writes one, made from the given clip edit. */
const planFrom = (edit: StyledEdit, range = RANGE, s: RequestSpec | null = spec()): ClipPlan => {
  const effective = effectiveRender(range, edit, s, null);
  return {
    schema_version: 2,
    clip_id: "r01c1",
    // the renderer snaps the boundaries onto whole words; that is not a producer change
    start_ms: range.start_ms - 120,
    end_ms: range.end_ms + 80,
    duration_ms: range.end_ms - range.start_ms,
    version: null,
    options: { ...effective.options, brand: null },
    ...({ requested: { start_ms: range.start_ms, end_ms: range.end_ms }, prepared_at: 1000 } as object),
  } as ClipPlan;
};

const report = { rendered_at: 1010 };
const now = (edit: StyledEdit, range = RANGE, s: RequestSpec | null = spec()) => effectiveRender(range, edit, s, null);

const template = (over: Partial<BrandTemplate> = {}): BrandTemplate => ({
  ...emptyTemplate("House", 1000),
  captions: { preset: "bold-impact" },
  layout: { mode: "solo_follow", aspect: "4:5" },
  cleanup: { filler_policy: "cut", silence_policy: "keep", mode: "smart" },
  ...over,
});

describe("stamping a brand onto one clip", () => {
  it("never overwrites a choice the producer made by hand", () => {
    const own: StyledEdit = { layout_mode: "full_frame", caption_style: { preset: "minimal" }, filler_policy: "keep" };
    const patch = applyTemplate(template(), own);
    expect(patch.layout_mode).toBeUndefined();
    expect(patch.caption_style).toBeUndefined();
    expect(patch.filler_policy).toBeUndefined();
    expect(patch.aspect).toBe("4:5");
    expect(patch.brand?.hash).toBe(resolveBrand(template()).hash);
  });

  it("fills in everything that has not been chosen", () => {
    const patch = applyTemplate(template(), {});
    expect(patch.caption_style?.preset).toBe("bold-impact");
    // and names the look in a word today's renderer already knows
    expect(patch.caption_preset).toBe("white-outline");
    expect(patch.captions).toBe("white-outline");
    expect(patch.layout_mode).toBe("solo_follow");
    expect(patch.silence_policy).toBe("keep");
  });

  it("reads the style fields off a plain clip edit", () => {
    expect(styleOf(null).aspect).toBeUndefined();
    expect(styleOf({ aspect: "1:1" } as StyledEdit).aspect).toBe("1:1");
  });
});

describe("what a clip would be rendered with", () => {
  it("falls back to the request, then the house default", () => {
    const withSpec = now({}, RANGE, spec({ caption_preset: "minimal", filler_policy: "cut" }));
    expect(withSpec.options.caption_preset).toBe("minimal");
    expect(withSpec.options.filler_policy).toBe("cut");
    expect(withSpec.options.duration_seconds).toBe(42);
    expect(withSpec.options.aspect).toBe("9:16");
    const bare = now({}, RANGE, null);
    expect(bare.options.caption_preset).toBe("classic");
    expect(bare.options.silence_policy).toBe("tighten");
    expect(bare.options.duration_seconds).toBeNull();
  });

  it("gives the same work the same fingerprint whatever order it was written in", () => {
    expect(renderSignature(now({ aspect: "4:5", title: "a" }))).toBe(renderSignature(now({ title: "a", aspect: "4:5" })));
    expect(renderSignature(now({ aspect: "4:5" }))).not.toBe(renderSignature(now({ aspect: "1:1" })));
  });
});

describe("preview freshness", () => {
  const base: StyledEdit = { filler_policy: "smart" };

  it("says nothing while the preview matches the edit", () => {
    expect(previewBehindEdits(planFrom(base), report, now(base))).toBe(false);
  });

  it("does not mistake the renderer's word snapping for a change", () => {
    const plan = planFrom(base);
    expect(plan.start_ms).not.toBe(RANGE.start_ms);
    expect(previewBehindEdits(plan, report, now(base))).toBe(false);
  });

  it("notices moved boundaries, a new look and a different shape", () => {
    const plan = planFrom(base);
    expect(previewBehindEdits(plan, report, now(base, { start_ms: 2000, end_ms: 41_000 }))).toBe(true);
    expect(previewBehindEdits(plan, report, now({ ...base, caption_preset: "off" }))).toBe(true);
    expect(previewBehindEdits(plan, report, now({ ...base, aspect: "1:1" }))).toBe(true);
    expect(previewBehindEdits(plan, report, now({ ...base, disabled_cuts: ["c1"] }))).toBe(true);
  });

  it("knows a caption look by name, however much the renderer fills in", () => {
    const look: StyledEdit = { ...base, caption_style: { preset: "boxed-focus" } };
    const plan = planFrom(look);
    // the renderer writes the whole look back, not just its name
    (plan.options as Record<string, unknown>).caption_style = { preset: "boxed-focus", size: 44, color: "#FFFFFF", max_words: 5 };
    expect(previewBehindEdits(plan, report, now(look))).toBe(false);
    expect(previewBehindEdits(plan, report, now({ ...base, caption_style: { preset: "color-pop" } }))).toBe(true);
  });

  it("ignores a setting the renderer never reported", () => {
    const plan = planFrom(base);
    delete (plan.options as Record<string, unknown>).aspect;
    expect(previewBehindEdits(plan, report, now({ ...base, aspect: "4:5" }))).toBe(false);
  });

  it("notices a plan prepared after the video was made", () => {
    const plan = { ...planFrom(base), prepared_at: 5000 } as ClipPlan;
    expect(previewBehindEdits(plan, report, now(base))).toBe(true);
  });

  it("keeps quiet when there is nothing to compare", () => {
    expect(previewBehindEdits(null, report, now(base))).toBe(false);
    expect(previewBehindEdits(planFrom(base), null, now(base))).toBe(false);
  });

  it("follows the brand by its fingerprint, not the whole snapshot", () => {
    const brand = resolveBrand(template());
    const withBrand: StyledEdit = { ...base, brand };
    const plan = planFrom(withBrand);
    (plan.options as Record<string, unknown>).brand = { ...brand };
    expect(previewBehindEdits(plan, report, now(withBrand))).toBe(false);
    const other = resolveBrand(template({ cta: { text: "Follow for more" } }));
    expect(previewBehindEdits(plan, report, now({ ...base, brand: other }))).toBe(true);
  });
});
