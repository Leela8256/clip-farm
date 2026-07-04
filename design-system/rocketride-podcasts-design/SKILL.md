# SKILL: rocketride-podcasts design system (dark cinematic audio)

Use this skill whenever building UI for **rocketride-podcasts** or any
audio/voice/media tool that should feel like a dark, focused studio.

## When to use
- Podcast / audio editing surfaces, transcript + waveform views, EDL editors.
- Chat-driven editing agents over media.
- Any dark, cinematic, waveform-forward interface with a single signal accent.

## The system in one screen
- **Canvas is near-black.** `#08080A` base; panels `#0E0E11`; raised `#16161A`;
  hover `#1F1F24`. Depth = hairline (`rgba(255,255,255,.08)`) + soft glow. Never
  hard drop shadows.
- **Text** off-white `#F4F4F6` → secondary `#A6A6AE` → muted `#6E6E77`.
- **One signal accent:** periwinkle `#6E8BFF` — playhead, active waveform,
  focus ring, links. Nothing else gets a bright color.
- **Status hues (share L/C, vary hue only):** ready `#4FBF8F`, processing
  `#E0A34D`, danger `#E0625B`. Always paired with a 14%-alpha tint background.
- **Primary button is light-on-dark:** bg `#F4F4F6`, text `#08080A`. The accent
  is *not* the primary CTA.

## Type
- Display/headings: **Space Grotesk**, weight 600–700, letter-spacing `-0.02em`.
- Body/UI: **Manrope**, 13–15px.
- Mono: **IBM Plex Mono** for every timecode, LUFS/dBTP value, node name,
  EDL row, and eyebrow label (uppercase, `0.14em` tracking).

## Waveform motif (the signature)
Render audio as vertical bars: inactive `rgba(255,255,255,.22)`, played/active
in accent, cut regions `rgba(224,98,91,.5)`. Reuse the same bar system for the
scrubber and for EDL cut ranges.

## Spacing & shape
4px base (4/8/12/16/24/32/48/64). Radii 8/12/16/22, pill `999px`.

## Voice
Operator-grade and specific. Show real numbers in mono. One clear primary
action per screen. No emoji, no exclamation marks in product chrome; plain,
timecode-referencing language in the chat agent.

## Load order (in a DC)
Inline styles only inside `.dc.html`. Mirror the token values as literals; put
`@font-face`/Google `<link>` for Space Grotesk + Manrope + IBM Plex Mono in
`<helmet>`. For the real Next.js/Tailwind codebase, import
`colors_and_type.css` and map the `--rr-*` variables into the Tailwind theme.

## Don't
- Add a second bright accent or gradient wash.
- Put body copy in mono, or numbers in the sans.
- Use hard shadows, rounded-corner + left-border "callout" cards, or emoji.
- Make the primary CTA the accent color.
