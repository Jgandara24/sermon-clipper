# Session Summary — Kinetic Captions + P1 Resequencing (2026-08-13)

## Goal

Add word-level caption highlighting ("kinetic captions", Opus Clip / CapCut style) to the
clip export pipeline and the editor preview. The active word changes to an accent color and
pops in scale as it is spoken. Captions become fully customizable (sliders, color pickers, a
drag handle on the video).

## Key decisions made in this session

1. **Sequence a P1 subset first.** The Agentic Editor plan's P1.4/P1.5/P1.6 landed before the
   caption work, out of order. Reason: P1.5 (one continuous range) reduces caption timeline
   remapping to a single offset; P1.4 (remove word deletes) removes the token-merge data
   migration hazard; P1.6's own rule says "re-key before any caption tooling".
   Jake confirmed the P1.4 product decision: word deletes are removed.
2. **Per-word ASS events, not `\k` tags.** `\k` only wipes color. One absolutely-positioned
   Dialogue event per word state (`\an5\pos`) gives the scale pop and defeats libass reflow
   by construction.
3. **Own the line layout.** A shared, pure module measures and positions every word. The
   browser preview and the ASS generator consume the same numbers. Parity is a transform,
   not a re-implementation.
4. **Token merge is forward-only.** No backfill of stored transcripts. Editor word ids are
   positional; a backfill would silently re-point old `deletedWordIds`.
5. **Legacy presets do not animate.** `highlightMode: "none"` is pinned on Clean, Bold Serif,
   and Quiet. Karaoke and the new Kinetic preset opt in. No existing clip changes behavior.
6. **Georgia is replaced by Source Serif 4.** Microsoft faces cannot ship in the image. All
   shipped fonts are OFL, recorded in `public/fonts/LICENSES.md`.

## What was built

### Phase A — Groundwork
- `Dockerfile.worker`: installs `fontconfig`, `fonts-dejavu`, `fonts-freefont-ttf`; copies
  `public/fonts` to `/usr/share/fonts/truetype/custom`; runs `fc-cache`; **fails the image
  build** if `fc-list` cannot find Inter or Source Serif 4. Sets `CAPTION_FONT_DIR`.
- Worker readiness gate (`src/lib/worker/reliability.ts`) checks the fonts at startup.
- `public/fonts/`: Inter 400/600/700/800, Source Serif 4 400/600/700, `LICENSES.md`.
  `src/app/globals.css` loads the same files via `@font-face` (`font-display: block`).
- SRT pacing: `src/lib/transcription/timing.ts` distributes cue time by word length +
  punctuation pauses, with a 1200 ms per-word cap. Replaces uniform slices.

### Phase B — P1 subset
- **P1.4**: Word-delete / filler-delete controls removed. Script panel is read-only. Legacy
  clips get a "Restore all deleted words" conversion (`src/lib/editor/continuous-edit.ts`).
  The preview's separate deleted-word skip logic is gone.
- **P1.5**: Export renders one continuous range in **one** ffmpeg pass (was three). Legacy
  states with internal cuts are rejected with `CONTINUOUS_RANGE_REQUIRED` at the exports
  route and again in the worker. `kept-ranges.ts` retired and deleted.
- **P1.6 (widened)**: Caption line ids are word-anchored + hashed (`captionLineId`). Legacy
  `line-N` ids still read (dual-read); only stable ids are written. Override-generated words
  carry line-namespaced ids.

### Phase C — Kinetic captions
- `src/lib/transcription/token-merge.ts`: merges whisper.cpp sub-word tokens into whole
  words. The per-token `.trim()` that destroyed the word-boundary signal is deleted.
  200 ms guard stops late-stamped punctuation from stretching a word. CJK/length guards.
- `CaptionStyle` extended (fontWeight, highlightMode, highlightScale, outline, shadow,
  positionY, anchor, maxWordsPerLine) with `normalizeCaptionStyle`, shared
  `CAPTION_STYLE_LIMITS`, and color coercion for legacy documents. Zod overrides are all
  optional — every persisted `ClipEdit.editorState` still parses.
- New `kinetic` preset; `karaoke` now truly animates word-by-word.
- Shared parity modules: `src/lib/editor/caption-layout.ts` (measured layout) and
  `src/lib/editor/caption-animation.ts` (pop curve, exact libass `\t` semantics).
- `src/lib/export/ass-generator.ts` rewritten: one `\an5\pos` event per word state
  (base-before / active / base-after), `\t` scale pops, `\p1` pill rectangles per row,
  Fontname/Bold from the font registry. No `\k` anywhere.
- `src/lib/editor/fonts.ts` registry + `src/lib/export/font-metrics.ts` fontkit measurer.
  The render passes `fontsdir` to libass, so font resolution works on any host without
  fontconfig registration.
- `video-preview.tsx`: fixed 1080×1920 stage (the ASS coordinate space) scaled to fit,
  rAF-driven animation, drag handle (pointer + keyboard) writing `positionY`.
- `caption-style-panel.tsx` rebuilt: Typography / Highlight / Stroke & shadow / Position
  groups, per-group resets, debounced sliders (`style-slider.tsx`).
- Docs: `DECISIONS.md` (karaoke deferral superseded; three new dated entries),
  `docs/DEPLOYMENT.md`, `docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md` status revision,
  `.env.example` (`CAPTION_FONT_DIR`).

## Verification results

| Gate | Result |
|---|---|
| `npm run verify` (prisma, lint, typecheck, unit tests, build) | Pass — 576 tests, 77 files |
| `npm run worker:build` (fontkit bundles under esbuild) | Pass |
| Real ffmpeg render of a kinetic clip | Pass — 22 events, clean render |
| Font gate: `fontselect` resolves `Inter ExtraBold` via `fontsdir` | Pass — shipped TTF used |
| Stability: same caption state, two frames | Pixel-identical (PSNR ∞) |
| **No-reflow**: non-active word region while neighbor pops | Bit-identical (PSNR ∞) |
| Integration tests (real Postgres + ffmpeg), incl. new `CONTINUOUS_RANGE_REQUIRED` test | Pass in isolation; parallel-run timeouts were load flakes in unrelated files |

New dependency: `fontkit` (MIT) + `@types/fontkit` (dev).

Changed: 34 files modified, ~1,620 insertions / 638 deletions, plus new files
(`token-merge.ts`, `timing.ts`, `continuous-edit.ts`, `caption-layout.ts`,
`caption-animation.ts`, `fonts.ts`, `font-metrics.ts`, `style-slider.tsx`,
`use-text-measurer.ts`, `public/fonts/*`, 6 new test files).

**Nothing is committed yet.** All work is in the working tree on
`codex/pre-p1-model-routing-trial`.

## Open questions and my recommendations

### 1. How do you want the commits cut?
- **A (recommended): One commit per plan step (~13 commits).** A1–A3, B1–B3, C1–C7 in the
  order the plan lists. Each step left the tree green, so each commit is revertible and
  reviewable on its own. This matches the repo's existing commit discipline.
- B: Three commits — one per phase (groundwork / P1 subset / kinetic captions).
- C: One squashed commit.

**My recommendation: A.** P1.4/P1.5/P1.6 are correctness changes that deserve their own
history separate from the feature; a revert of the caption UI must not drag the render
substrate with it. Also: this branch is named for the routing trial — I recommend a fresh
branch (for example `feat/kinetic-captions`) cut from here before committing.

### 2. When do we validate the worker Docker image?
- **A (recommended): On the next Railway build of the worker.** The `fc-list` gate fails the
  build if fonts do not register — no silent regression possible. Zero local time spent.
- B: I run `docker build -f Dockerfile.worker .` locally now (~15–25 min, whisper.cpp
  compiles from source).

**My recommendation: A.** The gate is deterministic; the local build adds time, not safety.

### 3. Who does the visual pass, and when?
- **A (recommended): You drive it now, before commits.** Open a clip editor, pick the
  Kinetic preset, play, drag the position handle, move the sliders, run one real export and
  watch it. This is the one gate automation cannot close, and your preference is to drive
  browser checks yourself.
- B: Commit first, visual pass after.

**My recommendation: A.** If the pop timing or default look feels wrong, tuning
`caption-animation.ts` constants or the `kinetic` preset before the commits keeps history
clean.

### 4. Do you want the Playwright e2e extension now?
- A: I add it now — preset switch to Kinetic, drag the handle, assert `positionY` persists
  after autosave and the overlay moved.
- **B (recommended): After your visual pass.** If the visual pass changes the UI (handle
  placement, panel layout), an e2e written now would be rewritten.

**My recommendation: B.** Write the e2e against the UI you have approved, not before.

### 5. Resume P1 afterwards?
- **A (recommended): Yes — resume at P1.1 (pinned edit versions), then P1.2, P1.3, P1.7.**
  P1.3 (mandatory render QC) is now more valuable: it would automatically catch a fontless
  or blank caption render in production.
- B: Pause P1 and focus on launch work.

**My recommendation: A, with P1.3 pulled to the front** of the remaining P1 items for
exactly that QC reason.
