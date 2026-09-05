# Slice 13 handoff, 2026-09-04

Written at the end of the session that built Slice 13, for whoever picks this up next. A fresh
terminal session has none of that session's context, so everything it needs is here.

Companion documents, in the order you would read them:

- `docs/EDITOR_DELTA_PLAN_2026-08-18.md` for the plan and the "Built" note under each slice.
- `DECISIONS.md` for why anything is the way it is. The 2026-09-04 entries are the newest.

---

## 1. Where the plan stands

**Slices 1 through 12 are merged to main.** Slice 10 (#65), Slice 11 (#67) and Slice 12 (#68)
landed on 2026-09-04. PR #66 (`suppressHydrationWarning` on the root element) is merged.

**Slice 13 is built and open as PR #69, awaiting the product owner's review.** It is deliberately
not merged: it is the final QA slice and the product owner asked to review it.

- Branch: `claude/slice-13-export-parity-qa-nsx9ma`
- PR: https://github.com/Jgandara24/sermon-clipper/pull/69
- Ten commits ahead of main. All four CI jobs green on the head commit (`e294383`).
- Review page (private artifact, phone readable):
  https://claude.ai/code/artifact/ab9649e5-7646-4297-8cdd-6548414c5afb

That closes every slice in the delta plan. There is no Slice 14.

---

## 2. What Slice 13 changed

### The one structural change

`buildExportRenderPlan` in `src/lib/exports/render-plan.ts` is new. It is a pure function of the
editor document, and it returns the kept ranges, the crop, the ASS subtitle script, the caption
count QC needs, the output duration and the audio gain.

Every one of those was previously computed inline inside `runExportJob`, between a storage download
and three ffmpeg passes. That is why the extraction was necessary rather than tidy: there was no way
to ask what an export would render without rendering one, so a parity test could only have been
written against a copy of the derivation, which would prove that the copy agreed with itself.

`runExportJob` now loads the brand template it already needed, calls the plan, and destructures it.
Behaviour is unchanged; the render integration suite and the unit suite were green across the
refactor commit on their own.

### The parity gate

`tests/integration/export-parity.integration.test.ts`, 15 assertions over four real MP4s rendered
through `runExportJob` itself.

It asserts against the same pure functions `src/components/editor/video-preview.tsx` draws the
preview with: `buildCaptionLines`, `resolveCaptionStyle`, `readTitleBanner`, `applyTextCase`. That
is what makes it a parity test rather than a snapshot. A preview change that the export did not
follow breaks it.

The test source is a colour clock: one flat colour per second of source. So the trim is checked as a
picture rather than as arithmetic. Every output second must show the source second the trim asked
for; a render that started at zero, or drifted, shows a different colour.

What it covers:

- A 9:16 MP4 that decodes, carries audio, and passes render QC with every check green.
- Duration equal to the trim, and the trim's own colour clock at every second.
- Exactly the words the trim kept, and neither of the words on its edges.
- Caption timing remapped onto the output timeline.
- Caption size, weight, alignment and highlight colour from the document's resolved style.
- Title face, size, timing and anchoring from the banner, drawn only while it is timed to be on
  screen.
- Audio volume, measured with `astats`.
- No editor chrome, checked from the ASS script and from the frame.

### The billing badge

`workspaceAccessLabel(state)` in `src/lib/billing/access.ts` is an exhaustive `switch` with a
`never` check, unit-tested in `tests/billing-access.test.ts` across every access state and pinned to
the exact four strings the badge already showed. `src/components/app-shell.tsx` calls it where a
nested inline conditional used to be.

This is the one authorised exception to the plan's "no slice touches the badge" constraint. Do not
treat it as precedent for other work in that file.

---

## 3. Decisions settled on 2026-09-04

All three were the product owner's, and all three are recorded in `DECISIONS.md`.

| Decision | Outcome | Code change |
| --- | --- | --- |
| The plan's visual system | The application stays stone and teal. The prototype's black, white and red is not adopted, now or later. | None |
| The billing badge switch | Built, under a one-time authorised exception. | `access.ts`, `app-shell.tsx`, one unit test |
| Five-word clip title | A target the field counts against, not a limit it enforces. | None |

---

## 4. Open, and not to be resolved without the product owner

`DECISIONS.md`, "2026-09-02 - The Social Safe Area Is One Versioned Datum". Both halves are still
open. Slice 13 measured them and changed nothing, because resolving either re-renders clips a church
has already approved.

**The side margin.** The burn-in writes `MarginL` and `MarginR` of 40px (`captionMarginHPx()`). The
preview's guide draws its side band at `chrome.left` = 6 percent, which is 64.8px at 1080 wide. The
margin permits a caption to reach 24.8px into the band the guide tells the member to keep clear.
It is a permission, not a certainty: a one-row caption measured on a real export inks from x=84 to
x=995, so it sits inside the band, because it is not wide enough to reach the margin.

**The vertical anchor.** These are two different quantities, not two values of one quantity. The
burn-in anchors the caption's bottom edge: `\an2` with `MarginV` 230, so the edge sits at y=1690 in
a 1920-tall frame. The preview centres the whole caption block on `captionRestCentreY.bottom` = 0.86,
so its centre sits at y=1651.2 and the block grows about that point. They coincide at exactly one
block height and diverge either side of it. Measured on a real export, a one-row 52px caption inks
y=1642 to y=1693, so its own centre is y=1667.5, which is 16.3px from the preview's rest centre. A
two-row caption moves that number in the opposite direction.

The parity gate deliberately asserts neither. An assertion either way would freeze one of the two
answers before the product owner has picked one.

---

## 5. Follow-ups

1. **Playwright coverage for Slice 13.** Held by the plan until the product owner approves the final
   UI, so the selectors are written once. The parity checks are render level and need no browser.
2. **The original gate list.** Slice 13 says to re-run the rejected gates plus Gate 11. That list
   lives in the handoff document, which is not in this repository. Section 2 of the plan already
   records Gate 11 (export policy) as unblocked, and the slice's own behaviour bullets were treated
   as the gates. If the original list matters, it has to come from the product owner.
3. **Merging PR #69.** The product owner's call.

---

## 6. What Slice 13 found that the plan had wrong

Recorded in full in `DECISIONS.md`. Summarised here so a fresh session does not rediscover them.

- **A trim in an export is a range, never a mid-clip word cut.** P1.4's `assertContinuousRange`
  refuses an export whose document cuts words out of the middle, before any render happens. Such a
  document never reaches a renderer, so there is nothing to check parity against. Do not write a
  test that deletes a word from the middle of a clip and expects a shorter render.
- **A one-pixel guide line has no colour in the exported file.** A two-pixel teal line burned into a
  flat frame measures rgb(186,184,206), near grey: 4:2:0 chroma subsampling averages a thin line's
  chroma into its neighbours. A colour scan cannot see it. The gate keeps the colour scan for filled
  shapes and catches thin guides two other ways: a per-pixel comparison of everything outside the
  captions and title against the flat source colour, and a centre-column comparison against its
  neighbours. Both were confirmed against frames with a guide deliberately burned in, so neither
  passes by being blind.
- **`src/lib/qc/render-output.ts` did not need extending.** Shape, duration, audio presence and
  caption events already cover every gate Slice 13 asks for.

---

## 7. Running this locally

### Local environment quirks

These are real and cost time if rediscovered:

- **Kill `next dev` before any Playwright run.** A running dev server is reused, and its storage root
  breaks every video test.
- **The upload e2e spec and the retention integration test fail locally** for environment reasons and
  pass on CI. Do not chase them.
- **CI only runs on pull requests.** To get checks on a branch, open a draft PR.
- **Do not regenerate `package-lock.json` with a bare macOS `npm install`.** It drops the
  `@emnapi/*` optional entries and breaks `npm ci` on Linux CI. If a regeneration is unavoidable,
  merge only the new subtree into main's lockfile.

### Commands

```bash
git fetch origin
git checkout claude/slice-13-export-parity-qa-nsx9ma
npm ci

# The verify gate: prisma validate + generate, lint, typecheck, unit tests, next build
npm run verify

# The worker build, and the font gate that lives in Dockerfile.worker
npm run worker:build

# Integration tests need a real Postgres and ffmpeg on PATH
docker compose up -d
npm run db:migrate:deploy
npm run test:integration

# Just the parity gate
npx vitest run --config vitest.integration.config.ts \
  tests/integration/export-parity.integration.test.ts
```

The parity gate renders four real MP4s and reads whole frames out of them, so it takes roughly a
minute on its own. That is the cost of the only evidence that answers the question the slice asks.

### The four CI jobs

`verify`, `integration`, `e2e`, `worker-image`. The worker font gate is inside `Dockerfile.worker`
and is proved by `worker-image`. Slice 13 touches neither the Dockerfile nor `public/fonts`.

---

## 8. Rules that still hold

From section 6 of the delta plan, and they outlast it:

- Small commits by coherent behaviour. Each leaves the relevant tests green.
- Failing behaviour tests first.
- Instant-preview changes stay in different commits from backend autosave changes.
- The app-shell billing block is never mixed with editor work. Slice 13's exception was authorised
  once, for one function, and is closed.
- Unrelated dirty-worktree changes are neither committed nor discarded. `AGENTS.md` is regenerated
  by `next dev`; leave it.
- Some tests deliberately record known defects as executable evidence: Sunday-spill scheduling,
  destructive reanalysis, the Stage A funnel ratio, the opening-quarter clip assertion. They belong
  to P1.7, P1.8, P1.9, P0.17 and P5. Do not "fix" them.

---

## 9. A starting prompt for the next session

Paste this into a fresh terminal session in this repository:

> Read `docs/SLICE_13_HANDOFF_2026-09-04.md`, then `DECISIONS.md` from the 2026-09-02 entries
> onward, then the Slice 12 and Slice 13 sections of `docs/EDITOR_DELTA_PLAN_2026-08-18.md`.
> PR #69 is open and green and is mine to merge. Do not merge it and do not touch the two open
> safe-area disagreements. Then tell me what you understand the state to be, and wait.
