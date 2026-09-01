/**
 * Brand looks: the caption gallery and the saved templates.
 *
 * A brand template is a producer's finishing kit — logo, opening and closing
 * clips, music, card wording, framing defaults and a caption look — kept in the
 * account store at `brand-templates/<id>/template.json` with its uploads beside
 * it under `assets/`. It belongs to the account, not to one recording, so the
 * same look can be used from Create Clips, the Episode Editor and AI Reframe.
 *
 * Two rules run through this module:
 *
 *  - **A look is data a render can receive.** Every field here reaches the
 *    render spec (caption style, logo, music, intro/outro, framing) — nothing
 *    on a brand page is decoration.
 *  - **A render carries a snapshot, never a reference.** `resolveBrand()`
 *    flattens a template into `{id, revision, hash, resolved}`; the render
 *    reads the snapshot and nothing else, so editing a template afterwards can
 *    never change a clip that was already made. The hash is a SHA-1 of the
 *    stable JSON of the snapshot, so the same look always fingerprints the same.
 *
 * The caption gallery ids are part of the product contract and are shared with
 * the nodes (`podcast_common/captions.py` resolves the same names), and the old
 * string presets (classic, yellow-bold, white-outline, minimal, off) keep
 * working both ways.
 */

import type { CSSProperties } from "react";
import {
  deleteFile,
  listDirStrict,
  readJsonStrict,
  saveJsonQueued,
  uploadFile,
  writeJson,
  type DirEntry,
  type StrictList,
  type StrictRead,
} from "./engine";
import { safeName } from "./podcast";

// ---------------------------------------------------------------- caption look

export interface CaptionStyle {
  preset?: string;
  font?: string;
  weight?: "normal" | "bold" | "black";
  /** px at a 1080-wide reference frame */
  size?: number;
  case?: "none" | "upper";
  color?: string;
  highlight_color?: string;
  outline?: { width: number; color: string };
  shadow?: boolean;
  box?: { color: string; opacity: number };
  position?: "bottom" | "middle" | "top";
  alignment?: "center" | "left";
  max_words?: number;
  max_lines?: 1 | 2;
  karaoke?: boolean;
  /** each word pops as it is said */
  emphasis?: boolean;
  /** words to pick out in the highlight colour */
  keywords?: string[];
  speaker_colors?: boolean;
}

export interface CaptionPresetCard {
  id: string;
  label: string;
  hint: string;
  style: CaptionStyle;
}

/** The gallery ids, in the order they are shown. Part of the contract. */
export const CAPTION_PRESET_IDS = [
  "none",
  "clean-karaoke",
  "bold-impact",
  "yellow-punch",
  "white-outline",
  "boxed-focus",
  "color-pop",
  "minimal",
  "two-line-social",
] as const;

export type CaptionPresetId = (typeof CAPTION_PRESET_IDS)[number];

/** The gallery, in the order it is shown. */
export const CAPTION_GALLERY: CaptionPresetCard[] = [
  { id: "none", label: "No captions", hint: "Just the picture and the sound", style: { preset: "none" } },
  {
    id: "clean-karaoke",
    label: "Clean karaoke",
    hint: "Word lights up as it is said",
    style: {
      preset: "clean-karaoke",
      weight: "bold",
      size: 48,
      color: "#FFFFFF",
      highlight_color: "#FFD84D",
      outline: { width: 3, color: "#000000" },
      max_words: 4,
      max_lines: 2,
      karaoke: true,
      position: "bottom",
      alignment: "center",
    },
  },
  {
    id: "bold-impact",
    label: "Bold impact",
    hint: "Big all-caps, three words at a time",
    style: {
      preset: "bold-impact",
      weight: "black",
      size: 64,
      case: "upper",
      color: "#FFFFFF",
      outline: { width: 6, color: "#000000" },
      shadow: true,
      max_words: 3,
      max_lines: 1,
      position: "middle",
      alignment: "center",
    },
  },
  {
    id: "yellow-punch",
    label: "Yellow punch",
    hint: "Loud yellow, each word pops",
    style: {
      preset: "yellow-punch",
      weight: "black",
      size: 56,
      case: "upper",
      color: "#FFD400",
      outline: { width: 4, color: "#000000" },
      emphasis: true,
      max_words: 4,
      max_lines: 2,
      position: "bottom",
      alignment: "center",
    },
  },
  {
    id: "white-outline",
    label: "White outline",
    hint: "Plain white with a hard edge",
    style: {
      preset: "white-outline",
      weight: "bold",
      size: 48,
      color: "#FFFFFF",
      outline: { width: 4, color: "#000000" },
      max_words: 5,
      max_lines: 2,
      position: "bottom",
      alignment: "center",
    },
  },
  {
    id: "boxed-focus",
    label: "Boxed focus",
    hint: "White on a dark band",
    style: {
      preset: "boxed-focus",
      weight: "bold",
      size: 44,
      color: "#FFFFFF",
      box: { color: "#000000", opacity: 0.65 },
      max_words: 5,
      max_lines: 2,
      position: "bottom",
      alignment: "center",
    },
  },
  {
    id: "color-pop",
    label: "Colour pop",
    hint: "Spoken word in a bright accent",
    style: {
      preset: "color-pop",
      weight: "bold",
      size: 52,
      color: "#FFFFFF",
      highlight_color: "#FF4D6D",
      outline: { width: 3, color: "#000000" },
      karaoke: true,
      emphasis: true,
      max_words: 4,
      max_lines: 2,
      position: "bottom",
      alignment: "center",
    },
  },
  {
    id: "minimal",
    label: "Minimal",
    hint: "Small, quiet, out of the way",
    style: { preset: "minimal", weight: "normal", size: 36, color: "#FFFFFF", shadow: true, max_words: 6, max_lines: 1, position: "bottom", alignment: "center" },
  },
  {
    id: "two-line-social",
    label: "Two-line social",
    hint: "Two comfortable lines, left aligned",
    style: {
      preset: "two-line-social",
      weight: "bold",
      size: 42,
      color: "#FFFFFF",
      box: { color: "#101010", opacity: 0.45 },
      max_words: 7,
      max_lines: 2,
      position: "bottom",
      alignment: "left",
    },
  },
];

export const DEFAULT_CAPTION_PRESET: CaptionPresetId = "clean-karaoke";

/** Older saved clips (and request specs) name captions with these words. */
export const LEGACY_CAPTION_PRESETS: Record<string, string> = {
  classic: "clean-karaoke",
  "yellow-bold": "yellow-punch",
  "white-outline": "white-outline",
  minimal: "minimal",
  off: "none",
};

/** What today's renderer understands, for every gallery card. */
export const GALLERY_TO_LEGACY: Record<string, string> = {
  none: "off",
  "clean-karaoke": "classic",
  "bold-impact": "white-outline",
  "yellow-punch": "yellow-bold",
  "white-outline": "white-outline",
  "boxed-focus": "classic",
  "color-pop": "yellow-bold",
  minimal: "minimal",
  "two-line-social": "classic",
};

/** The gallery card for a name, in either vocabulary. */
export const captionCard = (id: string | null | undefined): CaptionPresetCard | null =>
  CAPTION_GALLERY.find((c) => c.id === (id ? LEGACY_CAPTION_PRESETS[id] ?? id : id)) ?? null;

/** The gallery card a saved clip is on, whatever vocabulary it was saved with. */
export function galleryIdOf(style: CaptionStyle | null | undefined, preset?: string | null): string {
  if (style?.preset && captionCard(style.preset)) return captionCard(style.preset)!.id;
  if (preset && captionCard(preset)) return captionCard(preset)!.id;
  return DEFAULT_CAPTION_PRESET;
}

/** The word for this look that every renderer, new or old, already knows. */
export const legacyPresetOf = (galleryId: string): string => GALLERY_TO_LEGACY[LEGACY_CAPTION_PRESETS[galleryId] ?? galleryId] ?? "classic";

/** True when this look means "no captions at all". */
export const captionsOff = (value: CaptionStyle | string | null | undefined): boolean =>
  (typeof value === "string" ? captionCard(value)?.id : galleryIdOf(value)) === "none";

/** A name or a partial look, filled out into the whole thing (the card's style under the producer's own fields). */
export function resolveCaptionStyle(value: CaptionStyle | string | null | undefined): CaptionStyle {
  if (!value) return { ...CAPTION_GALLERY[1].style };
  if (typeof value === "string") return { ...(captionCard(value)?.style ?? CAPTION_GALLERY[1].style) };
  const base = value.preset ? captionCard(value.preset)?.style ?? {} : {};
  return { ...base, ...value };
}

function hexWithAlpha(hex: string, opacity: number): string {
  const clean = (hex || "").replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const n = parseInt(full || "000000", 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, opacity))})`;
}

/**
 * The look as browser CSS, for the live sample on a gallery card or in the
 * caption designer. It is a fair likeness, not the render: the burned-in
 * captions come from the same style through libass, and any screen showing
 * this must say it is approximate.
 *
 * `scale` multiplies the sample's own type size (1 = the 11 px card sample).
 */
export function captionCss(value: CaptionStyle | string | null | undefined, opts: { scale?: number; basePx?: number } = {}): CSSProperties {
  const s = resolveCaptionStyle(value);
  const base = opts.basePx ?? 11;
  const size = (s.size ?? 44) / 44;

  const css: CSSProperties = {
    color: s.color ?? "#FFFFFF",
    fontWeight: s.weight === "black" ? 900 : s.weight === "normal" ? 400 : 700,
    fontSize: `${Math.max(9, Math.round(base * size * (opts.scale ?? 1)))}px`,
    lineHeight: 1.25,
    textTransform: s.case === "upper" ? "uppercase" : "none",
    textAlign: s.alignment === "left" ? "left" : "center",
    fontFamily: s.font ?? "var(--rr-font-sans)",
    letterSpacing: s.case === "upper" ? "0.01em" : "0",
  };
  const shadows: string[] = [];
  if (s.outline) {
    const w = Math.max(1, Math.round(s.outline.width / 4));
    const c = s.outline.color;
    shadows.push(`${w}px 0 0 ${c}`, `-${w}px 0 0 ${c}`, `0 ${w}px 0 ${c}`, `0 -${w}px 0 ${c}`);
  }
  if (s.shadow) shadows.push("0 2px 3px rgba(0,0,0,0.55)");
  if (shadows.length) css.textShadow = shadows.join(", ");
  if (s.box) {
    css.background = hexWithAlpha(s.box.color, s.box.opacity);
    css.padding = "2px 6px";
    css.borderRadius = "4px";
  }
  return css;
}

/** The colour of the word being spoken, for the sample line. */
export const captionHighlightCss = (value: CaptionStyle | string | null | undefined): CSSProperties => {
  const s = resolveCaptionStyle(value);
  return s.highlight_color ? { color: s.highlight_color } : {};
};

// ------------------------------------------------------------------ templates

export const BRAND_ROOT = "brand-templates";
export const templateRoot = (id: string) => `${BRAND_ROOT}/${id}`;
export const templatePath = (id: string) => `${templateRoot(id)}/template.json`;
export const templateAssetsRoot = (id: string) => `${templateRoot(id)}/assets`;

export const TEMPLATE_SCHEMA_VERSION = 1;

export interface BrandTemplate {
  schema_version: number;
  id: string;
  name: string;
  created: number;
  updated: number;
  revision: number;
  default?: boolean;
  logo?: { path: string; corner: string; height: number; opacity: number };
  cta?: { text: string };
  headline?: { text: string };
  intro?: { path: string };
  outro?: { path: string };
  music?: { path: string; gain_db: number; duck_db: number; fade_ms: number };
  layout?: { mode: string; aspect: string };
  cleanup?: { filler_policy: string; silence_policy: string; mode: string };
  captions?: CaptionStyle;
}

export interface ResolvedBrand {
  id: string;
  revision: number;
  hash: string;
  resolved: Record<string, unknown>;
}

export type BrandAssetKind = "logo" | "intro" | "outro" | "music";

const ASSET_EXT: Record<BrandAssetKind, string> = { logo: "png", intro: "mp4", outro: "mp4", music: "mp3" };

const CORNERS = ["tl", "tr", "bl", "br"];

// ---------------------------------------------------------------- store seam

export interface BrandIo {
  list: (path: string) => Promise<StrictList>;
  read: <T>(path: string) => Promise<StrictRead<T>>;
  save: (key: string, path: string, value: unknown) => Promise<void>;
  write: (path: string, value: unknown) => Promise<void>;
  remove: (path: string) => Promise<void>;
  upload: (path: string, file: File, onProgress?: (sent: number, total: number) => void) => Promise<string>;
}

const REAL_IO: BrandIo = {
  list: listDirStrict,
  read: readJsonStrict,
  save: saveJsonQueued,
  write: writeJson,
  remove: deleteFile,
  upload: uploadFile,
};

let io: BrandIo = { ...REAL_IO };

/** Test seam: swap where templates are read and written (null puts the store back). */
export function setBrandIo(patch: Partial<BrandIo> | null): void {
  io = patch ? { ...REAL_IO, ...patch } : { ...REAL_IO };
}

// ------------------------------------------------------------- normalisation

const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown, fallback: number): number => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

function captionStyleOf(raw: unknown): CaptionStyle | undefined {
  if (typeof raw === "string") return raw ? resolveCaptionStyle(raw) : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const r = rec(raw);
  const style: CaptionStyle = {};
  if (typeof r.preset === "string") style.preset = r.preset;
  if (typeof r.font === "string") style.font = r.font;
  if (r.weight === "normal" || r.weight === "bold" || r.weight === "black") style.weight = r.weight;
  if (r.size != null) style.size = num(r.size, 44);
  if (r.case === "upper" || r.case === "none") style.case = r.case;
  if (typeof r.color === "string") style.color = r.color;
  if (typeof r.highlight_color === "string") style.highlight_color = r.highlight_color;
  if (r.outline && typeof r.outline === "object") {
    const o = rec(r.outline);
    style.outline = { width: num(o.width, 3), color: str(o.color, "#000000") };
  }
  if (typeof r.shadow === "boolean") style.shadow = r.shadow;
  if (r.box && typeof r.box === "object") {
    const b = rec(r.box);
    style.box = { color: str(b.color, "#000000"), opacity: Math.max(0, Math.min(1, num(b.opacity, 0.5))) };
  }
  if (r.position === "bottom" || r.position === "middle" || r.position === "top") style.position = r.position;
  if (r.alignment === "center" || r.alignment === "left") style.alignment = r.alignment;
  if (r.max_words != null) style.max_words = Math.max(1, Math.round(num(r.max_words, 4)));
  if (r.max_lines != null) style.max_lines = num(r.max_lines, 2) >= 2 ? 2 : 1;
  if (typeof r.karaoke === "boolean") style.karaoke = r.karaoke;
  if (typeof r.emphasis === "boolean") style.emphasis = r.emphasis;
  if (Array.isArray(r.keywords)) style.keywords = r.keywords.filter((k): k is string => typeof k === "string");
  if (typeof r.speaker_colors === "boolean") style.speaker_colors = r.speaker_colors;
  return Object.keys(style).length ? style : undefined;
}

/** A template file as it can be trusted: unknown shapes come back null, missing fields are simply absent. */
export function normalizeTemplate(raw: unknown, fallbackId = ""): BrandTemplate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = rec(raw);
  const id = str(r.id, fallbackId).trim();
  if (!id) return null;
  const now = Date.now() / 1000;
  const template: BrandTemplate = {
    schema_version: Math.max(1, Math.round(num(r.schema_version, TEMPLATE_SCHEMA_VERSION))),
    id,
    name: str(r.name).trim() || "Untitled look",
    created: num(r.created, now),
    updated: num(r.updated, num(r.created, now)),
    revision: Math.max(1, Math.round(num(r.revision, 1))),
  };
  if (r.default === true) template.default = true;
  const logo = rec(r.logo);
  if (str(logo.path)) {
    template.logo = {
      path: str(logo.path),
      corner: CORNERS.includes(str(logo.corner)) ? str(logo.corner) : "tr",
      height: Math.max(1, Math.round(num(logo.height, 80))),
      opacity: Math.max(0, Math.min(1, num(logo.opacity, 0.9))),
    };
  }
  if (str(rec(r.cta).text).trim()) template.cta = { text: str(rec(r.cta).text).trim() };
  if (str(rec(r.headline).text).trim()) template.headline = { text: str(rec(r.headline).text).trim() };
  if (str(rec(r.intro).path)) template.intro = { path: str(rec(r.intro).path) };
  if (str(rec(r.outro).path)) template.outro = { path: str(rec(r.outro).path) };
  const music = rec(r.music);
  if (str(music.path)) {
    template.music = {
      path: str(music.path),
      gain_db: num(music.gain_db, -18),
      duck_db: num(music.duck_db, -12),
      fade_ms: Math.max(0, Math.round(num(music.fade_ms, 800))),
    };
  }
  const layout = rec(r.layout);
  if (str(layout.mode) || str(layout.aspect)) template.layout = { mode: str(layout.mode, "auto"), aspect: str(layout.aspect, "9:16") };
  const cleanup = rec(r.cleanup);
  if (str(cleanup.filler_policy) || str(cleanup.silence_policy) || str(cleanup.mode)) {
    template.cleanup = {
      filler_policy: str(cleanup.filler_policy, "smart"),
      silence_policy: str(cleanup.silence_policy, "tighten"),
      mode: str(cleanup.mode, "natural"),
    };
  }
  const captions = captionStyleOf(r.captions);
  if (captions) template.captions = captions;
  return template;
}

/** A readable, unique folder name for a new look. */
export function templateIdFor(name: string, now: number = Date.now()): string {
  const stem = safeName(name.toLowerCase().replace(/\s+/g, "-")).replace(/^_+|_+$/g, "").slice(0, 32) || "look";
  return `${stem}-${now.toString(36).slice(-6)}`;
}

/** A blank look, ready to be filled in. */
export function emptyTemplate(name: string, now: number = Date.now()): BrandTemplate {
  return {
    schema_version: TEMPLATE_SCHEMA_VERSION,
    id: templateIdFor(name, now),
    name: name.trim() || "Untitled look",
    created: now / 1000,
    updated: now / 1000,
    revision: 1,
    captions: { ...CAPTION_GALLERY[1].style },
    layout: { mode: "auto", aspect: "9:16" },
  };
}

const byName = (a: BrandTemplate, b: BrandTemplate) =>
  a.default === b.default ? a.name.localeCompare(b.name) : a.default ? -1 : 1;

export interface TemplateListing {
  templates: BrandTemplate[];
  /** a read went wrong — the screen must say so instead of showing an empty shelf */
  failed: boolean;
  error: string | null;
}

/**
 * Every saved look, default first then by name — fail-closed: a listing that
 * could not be read says so rather than pretending the shelf is empty.
 */
export async function loadTemplates(): Promise<TemplateListing> {
  const listing = await io.list(BRAND_ROOT);
  if (!listing.ok) {
    if (listing.missing) return { templates: [], failed: false, error: null };
    return { templates: [], failed: true, error: listing.error || "The brand looks could not be read." };
  }
  const dirs = listing.entries.filter((e: DirEntry) => e.type === "dir" || e.type === "directory").map((e) => e.name);
  const reads = await Promise.all(dirs.map(async (name) => ({ name, read: await io.read<unknown>(templatePath(name)) })));
  const templates: BrandTemplate[] = [];
  let error: string | null = null;
  for (const { name, read } of reads) {
    if (read.ok) {
      const t = normalizeTemplate(read.value, name);
      if (t) templates.push(t);
    } else if (!read.missing) {
      error = error ?? read.error;
    }
  }
  return { templates: templates.sort(byName), failed: !!error, error };
}

/** The quiet listing for screens that only want what is there (pickers). */
export async function listTemplates(): Promise<BrandTemplate[]> {
  return (await loadTemplates()).templates;
}

/** The same list under the name Create Clips asks for. */
export const listBrandTemplates = listTemplates;

/** One look. null = there is no such file; a read that FAILED throws. */
export async function loadTemplate(id: string): Promise<BrandTemplate | null> {
  const read = await io.read<unknown>(templatePath(id));
  if (read.ok) return normalizeTemplate(read.value, id);
  if (read.missing) return null;
  throw new Error(read.error || "That brand look could not be opened.");
}

export interface SaveTemplateOptions {
  /** false while autosaving a field the producer is still typing into */
  bump?: boolean;
  now?: number;
}

/**
 * Write a look. Every save moves the revision on a number, so a clip made
 * from it can always say which version of the look it carries.
 */
export async function saveTemplate(template: BrandTemplate, options: SaveTemplateOptions = {}): Promise<BrandTemplate> {
  const now = (options.now ?? Date.now()) / 1000;
  const next: BrandTemplate = {
    ...template,
    schema_version: TEMPLATE_SCHEMA_VERSION,
    revision: options.bump === false ? Math.max(1, template.revision) : Math.max(1, template.revision) + 1,
    updated: now,
  };
  await io.save(`brand:${next.id}`, templatePath(next.id), next);
  return next;
}

export async function createTemplate(name: string, now: number = Date.now()): Promise<BrandTemplate> {
  const template = emptyTemplate(name, now);
  await io.save(`brand:${template.id}`, templatePath(template.id), template);
  return template;
}

/** A copy under a new name, starting again at revision 1 and never the default. */
export async function duplicateTemplate(template: BrandTemplate, name?: string, now: number = Date.now()): Promise<BrandTemplate> {
  const copyName = (name ?? `${template.name} copy`).trim() || `${template.name} copy`;
  const copy: BrandTemplate = {
    ...template,
    id: templateIdFor(copyName, now),
    name: copyName,
    created: now / 1000,
    updated: now / 1000,
    revision: 1,
  };
  delete copy.default;
  await io.save(`brand:${copy.id}`, templatePath(copy.id), copy);
  return copy;
}

/** Remove a look and the uploads that belong to it. */
export async function deleteTemplate(id: string, template?: BrandTemplate | null): Promise<void> {
  const assets = [template?.logo?.path, template?.intro?.path, template?.outro?.path, template?.music?.path].filter(
    (p): p is string => !!p && p.startsWith(templateAssetsRoot(id))
  );
  for (const path of assets) {
    try {
      await io.remove(path);
    } catch {
      /* an asset that is already gone must not stop the delete */
    }
  }
  await io.remove(templatePath(id));
}

/**
 * Make one look the default and clear the flag on the others it is given.
 * Returns every template it wrote, so the screen can show the new state
 * without another round trip.
 */
export async function setDefaultTemplate(id: string, known: BrandTemplate[]): Promise<BrandTemplate[]> {
  const written: BrandTemplate[] = [];
  for (const t of known) {
    const shouldBeDefault = t.id === id;
    if (!!t.default === shouldBeDefault) {
      written.push(t);
      continue;
    }
    const next: BrandTemplate = { ...t, updated: Date.now() / 1000 };
    if (shouldBeDefault) next.default = true;
    else delete next.default;
    await io.save(`brand:${next.id}`, templatePath(next.id), next);
    written.push(next);
  }
  return written.sort(byName);
}

/** The default look, when the producer has set one. */
export const defaultTemplate = (templates: BrandTemplate[]): BrandTemplate | null => templates.find((t) => t.default) ?? null;

/** Put an upload (logo, intro, outro, music) beside the look and hand back where it landed. */
export async function uploadTemplateAsset(
  id: string,
  kind: BrandAssetKind,
  file: File,
  onProgress?: (sent: number, total: number) => void
): Promise<string> {
  const name = safeName(file.name || `${kind}.${ASSET_EXT[kind]}`);
  const ext = (name.includes(".") ? name.split(".").pop() : "") || ASSET_EXT[kind];
  const path = `${templateAssetsRoot(id)}/${kind}.${ext.toLowerCase()}`;
  await io.upload(path, file, onProgress);
  return path;
}

// ------------------------------------------------------------- brand snapshot

/** Stable JSON: object keys in a fixed order, so the same work always reads the same. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/** Alias for the name the rest of the product uses. */
export const stableStringify = stableJson;

/**
 * SHA-1 of a string, as hex. Small and dependency-free: it fingerprints a
 * brand snapshot so a render can say which look it was made from — it is an
 * identity, never a secret.
 */
export function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const blocks = new Uint8Array(((bytes.length + 8) >> 6 << 6) + 64);
  blocks.set(bytes);
  blocks[bytes.length] = 0x80;
  const view = new DataView(blocks.buffer);
  const bits = bytes.length * 8;
  view.setUint32(blocks.length - 8, Math.floor(bits / 4294967296), false);
  view.setUint32(blocks.length - 4, bits >>> 0, false);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let i = 0; i < blocks.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) {
      const n = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = ((n << 1) | (n >>> 31)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number;
      let k: number;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/**
 * A template flattened into the snapshot a render carries. The render reads
 * this snapshot and nothing else, so a look edited afterwards can never change
 * a clip that was already made. The hash covers the snapshot only — the name,
 * the times and the revision of the file it came from are not part of it, so
 * renaming a look does not invalidate work made from it.
 */
export function resolveBrand(template: BrandTemplate): ResolvedBrand {
  const resolved: Record<string, unknown> = {
    name: template.name,
    ...(template.logo ? { logo: template.logo } : {}),
    ...(template.cta ? { cta: template.cta } : {}),
    ...(template.headline ? { headline: template.headline } : {}),
    ...(template.intro ? { intro: template.intro } : {}),
    ...(template.outro ? { outro: template.outro } : {}),
    ...(template.music ? { music: template.music } : {}),
    ...(template.layout ? { layout: template.layout } : {}),
    ...(template.cleanup ? { cleanup: template.cleanup } : {}),
    ...(template.captions ? { captions: resolveCaptionStyle(template.captions) } : {}),
  };
  const { name: _name, ...hashed } = resolved;
  void _name;
  return { id: template.id, revision: Math.max(1, template.revision), hash: sha1Hex(stableJson(hashed)), resolved };
}
