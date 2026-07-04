# rocketride-podcasts — Design System

> Dark, cinematic, waveform-forward. A monochrome studio surface with one signal
> accent. An independent analysis of publicly observable "ElevenLabs-style"
> patterns, applied to the rocketride-podcasts product. Not affiliated with,
> or endorsed by, ElevenLabs.

---

## 1. Brand context

**rocketride-podcasts** turns a raw recording into a broadcast-ready episode —
either hands-off (auto-pilot) or through plain-English conversation with a
RocketRide-native agent that edits a non-destructive EDL.

The product's hero is **audio**: transcripts, timestamps, waveforms, cuts,
loudness targets. The interface should feel like a **studio at night** — dark,
focused, precise — not a bright consumer dashboard. The waveform is the primary
visual motif; everything else recedes so the audio can be read at a glance.

**Emotional register:** premium · precise · calm · a little cinematic.
Confidence without noise. The UI never competes with the content.

---

## 2. Voice & tone

- **Direct, operator-grade.** "Rendering master — 3 of 5 nodes." Not "Hang tight!"
- **Show the numbers.** LUFS, true-peak, timestamps, node names. This audience
  trusts specificity. Surface real values in monospace.
- **Quiet confidence in auto-pilot.** One primary action, clearly labelled
  ("Make it broadcast-ready"). No exclamation marks, no emoji.
- **Conversational in chat mode.** The agent speaks plainly and references
  exact timecodes ("Cut 11:58–12:14 — the stumble. EDL updated, not rendered.").

---

## 3. Visual foundations

### Color
Near-black surface ramp (`--rr-bg` → `--rr-surface-3`), high-contrast off-white
text, and **one** signal hue — periwinkle `#6E8BFF` — reserved for the playhead,
active waveform, focus rings and links. Functional colors (ready / processing /
danger) share lightness & chroma and only vary hue, so status reads instantly
without turning the UI into a rainbow. Primary buttons are **light-on-dark** —
the signature inversion of a dark system.

### Type
- **Space Grotesk** — display & headings (tight, modern, cinematic).
- **Manrope** — body & UI (warm grotesque, legible at small sizes).
- **IBM Plex Mono** — timestamps, LUFS, node names, EDL rows, code.

Set headings tight (`-0.02em`); let mono carry all technical/audio data.

### Space & shape
4px spacing base. Radii 8/12/16/22. Elevation is **soft glow + hairline**, never
hard drop shadows — depth on black comes from luminance, not shadow.

### Waveform
The recurring motif. Inactive bars at 22% white; played/active region in the
accent; cut regions tinted danger at 50%. Timeline scrubbing and EDL cuts both
render against this same bar system.

---

## 4. Do / Don't

| Do | Don't |
|---|---|
| Keep the canvas near-black; let waveforms glow | Introduce a second bright accent |
| Use mono for every number, timecode, node name | Set body copy in mono |
| Primary CTA = light-on-dark | Make the primary CTA the accent color |
| Status via the 3 functional hues only | Invent new status colors |
| Depth via hairlines + glow | Hard drop shadows |

---

## 5. Files

- `colors_and_type.css` — token source of truth (CSS variables, type scale,
  utility classes) for the Next.js / Tailwind / shadcn codebase.
- `Foundations.dc.html` — visual style guide: color ramp, type, spacing,
  component primitives, brand.
- `RocketRide Podcasts UI Kit.dc.html` — the system on real product screens:
  upload, auto-pilot progress, and the chat + EDL editor.
- `SKILL.md` — portable skill for reusing this system in future work.

---

## 6. Google-font substitutes

The reference brand uses a proprietary grotesque. Public substitutes chosen for
the closest metrics & feel:

| Role | Font | Why |
|---|---|---|
| Display | Space Grotesk | Tight, technical grotesque with cinematic character |
| UI / body | Manrope | Warm, highly legible grotesque at 13–15px |
| Mono | IBM Plex Mono | Clean, tabular — ideal for timecodes & LUFS |
