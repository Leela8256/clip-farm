# Design System Selector

An internal tool for matching a product brief to the right house style from a fixed
menu of ~70 design systems, then scaffolding it. **One system per project.**

## Workflow

1. **Read the brief** — product, audience, register.
2. **Shortlist three** from the menu.
3. **Recommend one**, clearly.
4. **Fetch its `DESIGN.md`** and attach it.
5. **Scaffold** tokens, previews, UI kit, skill.

## Run it

Open `Design System Selector.dc.html` in a browser (it loads `support.js` from the
same folder). Search, filter by category, and click a system to get its
`DESIGN.md` fetch URL and the scaffold checklist.

## Files

- `Design System Selector.dc.html` — the tool (a Design Component).
- `support.js` — the DC runtime. Required; keep it next to the HTML.
- `source/design-system-selector.md` — the original selector prompt this was built from.

## Scaffold output (per selected system)

- `README.md` — brand context, voice, visual foundations
- `colors_and_type.css` — CSS variables, type scale, utility classes
- Google Font substitutes — if the brand font is proprietary
- `preview/` cards — colors, type, spacing, components, brand
- UI kit — `index.html` + components on real product screens
- `SKILL.md` — a portable skill file for future reuse
