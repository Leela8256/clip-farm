# Marketplace migration — classification & Phase-0 binding inventory

Per `app-development-docs/` (00-INDEX → 02 §Phase 0). Written 2026-09-01, before any porting.

## Classification: Category 1 — STANDALONE (Track B2, the full path)
Own repo · own router (Next.js app-router URL routes) · own frontend serving (static export + nginx in
Docker) · own connection management (`lib/engine.ts` constructs the SDK client) · localStorage for durable
UI state · local engine via `--node_path` · local Qdrant container · local `.env` secrets · custom nodes
that exist in NO catalog. Route: 01 → 02 (B2) → 03 all phases → 04 (mandatory for us) → 05 → 06.

## Deadline reality (flagged, not hidden)
The docs' development deadline (2026-08-27 18:00, through Stage 1 + node PRs raised) has passed; launch
is 2026-09-01. Nothing about this app is on staging yet. First human step: confirm with Shashidhar
whether a late slot exists before we spend the effort.

## Phase-0 binding inventory (the seven categories)

| Binding | What we have today | Target |
|---|---|---|
| **Shell/API** | Next.js app router (`/projects /episode /studio /reframe /brands /brand /history`), own `Sidebar`, own connection open/retry in the shell component, `new RocketRideClient()` in `lib/engine.ts` | One scaffolded MF app (`client.deploy.createApp`), ONE `app:` mount, `<AppLayout sidebar={…}>`, state-flag navigation (the shell owns the URL), `useShellConnection()`/`getClient()` — our engine.ts connection layer largely dissolves |
| **Configuration** | Goal presets, caption gallery, cleanup defaults etc. are code constants; no org vocabulary hardcoded (good); brand templates are already config-as-data in the store (good) | Keep templates as-is; move tunables (model profile, loudness target, preview tiers) into `appManifest.contributes.settings` |
| **State/storage** | Engine account file store `projects/<id>/…`, `brand-templates/`, `library/` (already pipeline-reachable — good); Qdrant as a personal docker container (`podcast_transcripts`); `localStorage` for recents + sidebar collapse | File store: verify the platform account store IS the staging store (probe). Qdrant → `rocketride_vector` via generator variants (`default` = rocketride_vector, `external` = qdrant) — our ARCHITECTURE.md already planned this. `localStorage` → `useWorkspace()` prefs |
| **Backend logic** | 12 hand-maintained `.pipe` files + byte-copy mirrors in `frontend/lib/pipelines/` + a parity test; 7 custom nodes loaded via `--node_path` (forbidden on staging: "locally-hacked node… fails on the server") | ONE pipe generator emitting workspace + app-local copies, stable project_ids (we have stable ids — carry them into the generator). Custom nodes: see below — the launch-critical item |
| **The clock** | None (no cron/scheduled work) | Nothing to do; note reindex-on-demand stays user-triggered |
| **Secrets** | `ROCKETRIDE_ANTHROPIC_KEY` in local `.env`, substituted by the local engine | Server-side org-scope environment overlay; documented in `.env.example`; set by its owner (human step) |
| **Identity/audit** | None — no auth, writes unstamped | `authenticated: true` in the manifest; stamp every store write (edits, templates, collections, batches) with `useAuthUser()` |

## Custom nodes — the launch-critical path (doc 04)
Rule: staging pipes may only reference nodes in **staging's** `services-catalog.json`. Our 7 nodes are in
no catalog. Per doc 04's decision ladder, our plan (matches `docs/UPSTREAM_NODES.md`, now a requirement,
not a strategy):
1. **Probe `tool_python` limits on staging first** — deterministic pure-logic nodes (`podcast_refine`,
   `podcast_segment`'s assembly, studio suggestion/spec logic) are candidates for the no-PR
   `tool_python` path (Spaceport engine-seeding pattern) IF the sandbox permits our imports; ffmpeg-heavy
   work almost certainly not.
2. **rocketride-server PRs (target `develop`), raised immediately** for the genuinely new providers:
   `media_render` (generalized `podcast_render`), transcriber word-timestamps/absolute-time options,
   `speaker_framing` (generalized layout/visual), `audio_diarize`, `media_probe`/`media_slice` —
   with tests under `nodes/test`, config schemas, no env-loop blocking. Review latency is the risk.
3. Two pipe variants per doc 04 interim rule: target (new nodes) + degraded (tool_python/skip) so the
   rest of the migration proceeds while PRs are in review. Never deploy a pipe referencing an unmerged node.

## Frontend port notes (Track B2 translation)
- Next static export → scaffolded rsbuild MF app; **pnpm only**; vendored `shell`/`rocketride` tgz pins.
- Tailwind must go → plain CSS style objects. Big mitigation: our design tokens are already `--rr-*`
  variables and the primitives are token-based; the mechanical work is replacing utility classes.
- Route pages → views behind state-flag navigation inside one mount; our Sidebar → `<AppLayout sidebar>`.
- Media playback via signed URLs continues; verify `client.*` calls against the vendored client (never
  the docs alone). Codegen (not loaders) for the pipe JSON imports if the server build lacks our rule —
  the docs say `.pipe`-as-JSON IS platform-canonical, so likely fine as-is.

## Stage-by-stage change list
- **Stage 0 (human + agent):** staging extension by content-check, Cloud mode to staging.rocketride.ai,
  4 env vars incl. DEPLOY pair, claim org developerId BEFORE scaffolding, redeem `HACKANAPP`.
- **Stage 1:** scaffold `apps/<name>` via createApp; port domain libs (mostly move as-is — they're
  React-free); data layer next; UI last with the translation table; delete Docker/nginx serving.
- **Custom nodes:** probes + PRs as above (the long pole; start first).
- **Stage 2:** generator + validate every variant against staging; deploy pipes `deployTo` team;
  `verifyApp` → `addApp` → server build ok → publish `@me`; complete manifest (icon, real README,
  categories, billing — pricing docs to be read when choosing plans).
- **Stage 3:** Qdrant → `rocketride_vector` (re-index via our existing transcript-index pipe = the
  "regenerate, don't copy" case; media/store files re-uploaded or re-created per project).
- **Stage 4:** checklist sign-off to Shashidhar.

## Human-owned steps (the app owner, not the agent)
Extension install/cleanup · staging API keys · developer-id claim · `HACKANAPP` redemption ·
setting secrets in the org overlay · getting node PRs reviewed/merged (Shashidhar/Dmitrii).
