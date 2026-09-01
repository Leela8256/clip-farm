/**
 * Brand looks: the gallery a producer picks from, and the snapshot a render
 * carries. Two things must never drift — the caption vocabulary (old saved
 * clips keep working) and the fingerprint of a look (a clip must be able to
 * say which version of a look it was made from).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTION_GALLERY,
  CAPTION_PRESET_IDS,
  captionCard,
  captionCss,
  captionHighlightCss,
  captionsOff,
  createTemplate,
  duplicateTemplate,
  emptyTemplate,
  galleryIdOf,
  legacyPresetOf,
  loadTemplates,
  normalizeTemplate,
  resolveBrand,
  resolveCaptionStyle,
  saveTemplate,
  setBrandIo,
  setDefaultTemplate,
  sha1Hex,
  stableJson,
  templatePath,
  type BrandTemplate,
} from "../brand";

function fakeStore(files: Record<string, unknown> = {}) {
  const dirs = (path: string) =>
    [...new Set(Object.keys(files).filter((f) => f.startsWith(`${path}/`)).map((f) => f.slice(path.length + 1).split("/")[0]))];
  setBrandIo({
    list: async (path) => ({ ok: true, entries: dirs(path).map((name) => ({ name, type: "dir" })) }),
    read: async <T,>(path: string) =>
      path in files ? { ok: true as const, value: files[path] as T } : { ok: false as const, missing: true, error: "" },
    save: async (_key, path, value) => {
      files[path] = value;
    },
    write: async (path, value) => {
      files[path] = value;
    },
    remove: async (path) => {
      delete files[path];
    },
  });
  return files;
}

afterEach(() => setBrandIo(null));

describe("the caption gallery", () => {
  it("carries exactly the nine looks the product names, in order", () => {
    expect(CAPTION_GALLERY.map((c) => c.id)).toEqual([...CAPTION_PRESET_IDS]);
    expect(CAPTION_GALLERY.every((c) => c.label && c.hint)).toBe(true);
  });

  it("keeps the old words working in both directions", () => {
    expect(captionCard("classic")?.id).toBe("clean-karaoke");
    expect(captionCard("yellow-bold")?.id).toBe("yellow-punch");
    expect(captionCard("white-outline")?.id).toBe("white-outline");
    expect(captionCard("minimal")?.id).toBe("minimal");
    expect(captionCard("off")?.id).toBe("none");
    // and back to a word today's renderer understands
    expect(legacyPresetOf("clean-karaoke")).toBe("classic");
    expect(legacyPresetOf("yellow-punch")).toBe("yellow-bold");
    expect(legacyPresetOf("none")).toBe("off");
    expect(legacyPresetOf("classic")).toBe("classic");
    expect(legacyPresetOf("bold-impact")).toBe("white-outline");
  });

  it("fills a partial look out from its card and knows when captions are off", () => {
    const style = resolveCaptionStyle({ preset: "bold-impact", color: "#00FF00" });
    expect(style.weight).toBe("black");
    expect(style.case).toBe("upper");
    expect(style.color).toBe("#00FF00");
    expect(galleryIdOf(style)).toBe("bold-impact");
    expect(captionsOff(style)).toBe(false);
    expect(captionsOff("off")).toBe(true);
    expect(captionsOff({ preset: "none" })).toBe(true);
  });
});

describe("captionCss", () => {
  it("shows the karaoke look: white text, an outline and the highlight colour", () => {
    const css = captionCss("clean-karaoke");
    expect(css.color).toBe("#FFFFFF");
    expect(css.fontWeight).toBe(700);
    expect(String(css.textShadow)).toContain("#000000");
    expect(css.textTransform).toBe("none");
    expect(captionHighlightCss("clean-karaoke").color).toBe("#FFD84D");
  });

  it("shows the bold look bigger, heavier and in capitals", () => {
    const bold = captionCss("bold-impact");
    const clean = captionCss("clean-karaoke");
    expect(bold.fontWeight).toBe(900);
    expect(bold.textTransform).toBe("uppercase");
    expect(parseFloat(String(bold.fontSize))).toBeGreaterThan(parseFloat(String(clean.fontSize)));
  });

  it("shows the boxed look on a band and the left-aligned one left", () => {
    const boxed = captionCss("boxed-focus");
    expect(boxed.background).toBe("rgba(0, 0, 0, 0.65)");
    expect(boxed.padding).toBeTruthy();
    expect(captionCss("two-line-social").textAlign).toBe("left");
  });

  it("scales for a bigger preview without changing the look", () => {
    const small = captionCss("minimal");
    const big = captionCss("minimal", { scale: 3 });
    expect(parseFloat(String(big.fontSize))).toBeGreaterThan(parseFloat(String(small.fontSize)));
    expect(big.color).toBe(small.color);
  });
});

describe("sha1Hex and stableJson", () => {
  it("matches the known SHA-1 answers", () => {
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("The quick brown fox jumps over the lazy dog")).toBe("2fd4e1c67a2d28fced849ee1bb76e7391b93eb12");
  });

  it("writes the same JSON whatever order the keys were made in", () => {
    expect(stableJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(stableJson({ a: [2, { c: 3, d: 4 }], b: 1 }));
  });
});

describe("resolveBrand", () => {
  const base: BrandTemplate = {
    ...emptyTemplate("Studio look", 1_700_000_000_000),
    logo: { path: "brand-templates/x/assets/logo.png", corner: "tr", height: 80, opacity: 0.9 },
    music: { path: "brand-templates/x/assets/music.mp3", gain_db: -18, duck_db: -12, fade_ms: 800 },
  };

  it("fingerprints the same look the same way, whatever order it was built in", () => {
    const a = resolveBrand(base);
    const b = resolveBrand({ ...base, music: { ...base.music! }, logo: { ...base.logo! } });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toHaveLength(40);
    expect(a.revision).toBe(base.revision);
  });

  it("changes the fingerprint when the look itself changes, but not when it is renamed", () => {
    const original = resolveBrand(base);
    const renamed = resolveBrand({ ...base, name: "Another name", revision: 9 });
    const changed = resolveBrand({ ...base, logo: { ...base.logo!, corner: "bl" } });
    expect(renamed.hash).toBe(original.hash);
    expect(changed.hash).not.toBe(original.hash);
  });

  it("carries the caption look filled out, so the render never re-reads the template", () => {
    const resolved = resolveBrand({ ...base, captions: { preset: "yellow-punch" } });
    expect((resolved.resolved.captions as { weight?: string }).weight).toBe("black");
    expect(resolved.resolved.logo).toBeTruthy();
  });
});

describe("templates on file", () => {
  it("makes, saves and reads one back, moving the revision on each save", async () => {
    const files = fakeStore();
    const made = await createTemplate("My look", 1_700_000_000_000);
    expect(files[templatePath(made.id)]).toBeTruthy();
    expect(made.revision).toBe(1);

    const saved = await saveTemplate({ ...made, cta: { text: "Follow for more" } });
    expect(saved.revision).toBe(2);
    const quiet = await saveTemplate(saved, { bump: false });
    expect(quiet.revision).toBe(2);

    const listing = await loadTemplates();
    expect(listing.failed).toBe(false);
    expect(listing.templates.map((t) => t.id)).toEqual([made.id]);
    expect(listing.templates[0].cta?.text).toBe("Follow for more");
  });

  it("says so when a look could not be read instead of showing an empty shelf", async () => {
    setBrandIo({
      list: async () => ({ ok: false, missing: false, error: "the connection went away" }),
    });
    const listing = await loadTemplates();
    expect(listing.failed).toBe(true);
    expect(listing.error).toContain("connection");
    expect(listing.templates).toEqual([]);
  });

  it("duplicates a look as a fresh copy that is never the default", async () => {
    const files = fakeStore();
    const original = await createTemplate("Weekly show", 1_700_000_000_000);
    const marked = await saveTemplate({ ...original, default: true });
    const copy = await duplicateTemplate(marked, undefined, 1_700_000_001_000);
    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe("Weekly show copy");
    expect(copy.revision).toBe(1);
    expect(copy.default).toBeUndefined();
    expect(files[templatePath(copy.id)]).toBeTruthy();
  });

  it("gives exactly one look the default flag", async () => {
    fakeStore();
    const a = await createTemplate("A", 1_700_000_000_000);
    const b = await createTemplate("B", 1_700_000_001_000);
    const marked = await setDefaultTemplate(b.id, [{ ...a, default: true }, b]);
    expect(marked.filter((t) => t.default).map((t) => t.id)).toEqual([b.id]);
    const again = await setDefaultTemplate(a.id, marked);
    expect(again.filter((t) => t.default).map((t) => t.id)).toEqual([a.id]);
  });
});

describe("normalizeTemplate", () => {
  it("keeps what it recognises and drops what it does not", () => {
    const t = normalizeTemplate(
      {
        id: "look-1",
        name: "  Loud  ",
        revision: "3",
        logo: { path: "a/logo.png", corner: "nope", height: "120", opacity: 2 },
        music: { path: "a/m.mp3" },
        captions: { preset: "clean-karaoke", size: "50", max_lines: 5, keywords: ["hook", 3] },
        cleanup: { filler_policy: "cut" },
        junk: true,
      },
      "fallback"
    );
    expect(t?.name).toBe("Loud");
    expect(t?.revision).toBe(3);
    expect(t?.logo?.corner).toBe("tr");
    expect(t?.logo?.opacity).toBe(1);
    expect(t?.music?.gain_db).toBe(-18);
    expect(t?.captions?.size).toBe(50);
    expect(t?.captions?.max_lines).toBe(2);
    expect(t?.captions?.keywords).toEqual(["hook"]);
    expect(t?.cleanup?.silence_policy).toBe("tighten");
    expect((t as unknown as Record<string, unknown>).junk).toBeUndefined();
    expect(normalizeTemplate({ name: "no id" })).toBeNull();
    expect(normalizeTemplate(null)).toBeNull();
    expect(normalizeTemplate({ name: "borrowed" }, "from-folder")?.id).toBe("from-folder");
  });
});
