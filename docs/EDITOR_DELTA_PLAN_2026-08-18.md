# Editor Delta Implementation Plan — 2026-08-18

Source: `MOZI_REDESIGN_1_0_CLAUDE_HANDOFF_2026-08-17.md` (Jake's manual review of the redesigned
editor: 11 gates, 8 rejected, 1 blocked, 2 approved).

This plan describes behavior, not line numbers, so it survives the rebase of the editor prototype.
It is a **delta** against the prototype recorded on branch `p1/kinetic-captions-and-editor`, whose
final commit is labelled `PROTOTYPE, NOT ACCEPTED`.

**Status (2026-08-20): both decisions resolved. Nothing is blocked.** D1 resolved to neighbour
micro-shift, which becomes its own slice with a real render test; D2 resolved to hardened browser
extraction. Both are recorded in `DECISIONS.md`, so the reasoning survives this document.

Ahead of the slices, two pieces of the surrounding work have landed in production and are no
longer pending: the export-policy step (§2) and the Scribe provider activation (§7).

The prototype branch `p1/kinetic-captions-and-editor` is still unmerged, and its final commit is
still labelled `PROTOTYPE, NOT ACCEPTED`. It has not been reviewed and should not be, until this
plan is settled — the slices below are what turn it into something worth reviewing.

---

## 1. What the baseline actually gives us (corrected 2026-08-21, after Slice 7)

**The original version of this section was wrong, and the error was structural.** It made nine
claims about what was "already true in the baseline" and told the slices to wire or correct the
things it named. The artifacts it named — the modules and the two symbols — were on the
prototype branch `p1/kinetic-captions-and-editor` (`914d23d`), which this plan names as the thing
it is a delta against. The slices, though, were built on `origin/main`, and **before Slice 1 the
target branch lacked every one of those exact prototype artifacts.** Some of the behaviours they
described have since been built on `main` by the slices, under other names; some were true on
`main` all along by other means; some are still absent. The table says which. Slice 7 found the
gap when it went to wire the pop curve and had nothing to wire.

What follows was verified against `origin/main` at `276d3fd` (the merge of PR #51, Slice 7) by
reading the tree, not the plan. Slices 8 onward estimate against this table and nothing else.

| Original §1 claim | Verified state on `origin/main` | Where it lives now | Created by |
| --- | --- | --- | --- |
| Exactly one active caption word at any timestamp, even with overlapping source intervals (`activeCaptionWordId`, `exclusiveCaptionWordEnds`) | **True as "at most one", under different names.** Neither symbol exists. `resolveActiveWord(words, ms)` returns the single word covering `ms` — latest start wins, ties broken by shorter interval then later position — or **`null`** before the first interval, after the last, and in any gap between intervals. It is deterministic, not total over time. `exclusiveLineSpans` removes line overlap on the highlighting path only. | `src/lib/editor/active-word.ts` (`resolveActiveWord`), `src/lib/editor/caption-lines.ts` (`exclusiveLineSpans`) | Slice 7: `active-word.ts` in `631870c`; `exclusiveLineSpans` in `94c6601` |
| The pop curve is one shared definition both renderers evaluate (`caption-animation.ts`) | **True.** `popPhases`, `popScaleAt`, `popPhaseTags`, `popClock`, quantised to centiseconds and whole percent. Plus `caption-timeline.ts`: one selector (`captionActivations`) decides which line, which words and which stretch, read by both the preview and the burn-in. | `src/lib/editor/caption-animation.ts`, `src/lib/editor/caption-timeline.ts` | Slice 7: `caption-animation.ts` in `61e77a8`; `caption-timeline.ts` in `4741575`; the no-word stretch joined the grid in `3167e68` |
| Caption line layout is measured once and consumed by both renderers (`caption-layout.ts`, `font-metrics.ts`, `use-text-measurer.ts`) | **Absent.** No shared layout, no font-metrics measurer, no browser measurer hook, and no `fontkit`/`opentype` dependency. The preview lays words out with CSS inline-blocks; the burn-in emits one Dialogue per phase carrying the whole run and lets libass lay it out. Neither side knows a word's width. What does exist: the faces are bundled in `public/fonts`, served by `@font-face` and installed in the worker image, so the same TTF is available to measure on both sides. | — (`src/lib/editor/caption-fonts.ts` lists the bundled faces) | Not created. **Slice 8 must create it.** |
| Only Clean and Highlighter are offered; Clean does not animate; Highlighter is neon yellow, bottom-safe, word-by-word (`caption-presets.ts`) | **True now; not true before Slice 7.** Before Slice 7, `main` offered four presets (`clean`, `bold-serif`, `karaoke`, `quiet`), had no Highlighter, and highlighted nothing in either renderer — so "Clean does not animate" held only because nothing did. Since Slice 7: `selectable` marks Clean and Highlighter and the picker reads `SELECTABLE_CAPTION_PRESETS`; retired presets stay resolvable by id; `activeWordHighlight` is true for Highlighter alone, so Clean renders whole and lights nothing; Highlighter is `#CCFF00`, `position: "bottom"`, per-word. "Bottom-safe" means the preset's `position`, not a safe-area datum — see the next row. | `src/lib/editor/caption-presets.ts` | Slice 7 (`631870c`) |
| A versioned social safe area exists as data (`social-safe-area.ts`) | **Absent.** The canvas draws guide zones as inline CSS percentages (`inset-x-[6%] top-[6%] bottom-[12%]`) inside `VideoPreview`, toggled on screen and never exported. There is no data model, no version, no anchor vocabulary, and nothing the burn-in or a title default can read. | `src/components/editor/video-preview.tsx` (guides only) | Not created. **Slice 9 needs "Top Safe" and must create the datum.** |
| Panel min/max widths and a video minimum are already computed (`panel-resize.ts`) | **Absent.** There is no panel-resize module and no panel-width resize arithmetic. (The canvas has its own caption-object resize and pinch-zoom arithmetic; that is not panel width.) | — | Not created. Slice 12 owns the draggable dividers with min and max widths; it must create this. Slice 12's text is unchanged. |
| Undo/redo with grouping is already a pure reducer (`document-history.ts`) | **True, under a different name.** `createHistory`, `recordEdit`, `closeInteraction`, `undo`, `redo`, `applyConfirmedSave`, `historyShortcut` — pure functions, interaction-grouped. | `src/lib/editor/history.ts` | Slice 2 (`0850b90`) |
| A title-banner overlay model with defaults, upsert, remove, and dismiss (`title-banner.ts`) | **Absent.** `EditorState.overlays` is `z.array(z.unknown())`. The only overlay anything writes is the brand template's `{ type: "lowerThird" }`, and the only overlay the burn-in draws is that lower third. No title type, no defaults, no helpers, no track, no panel, no burn-in. | — | Not created. **Slice 9 must create it.** |
| Manual export no longer requires editorial approval, with billing and access untouched | **True.** The export route gates on workspace access, range continuity and rate limit; nothing checks approval. | `src/app/api/clips/[id]/exports/route.ts` | Landed before the slices — see §2 |

Two lessons, so the mistake is not repeated:

- **A plan's baseline is the branch the work will be built on, not the branch the plan was
  written from.** The prototype branch is still unmerged and still labelled `PROTOTYPE, NOT
  ACCEPTED`; nothing on it counts as existing on `main` until a slice builds it there.
- **Verify by reading the tree.** A module named in a plan is a claim; `git ls-tree` against the
  target branch is the evidence. Every slice from 8 onward states what it must create, and that
  statement comes from the repository, not from this document's history.

## 2. Handoff step 3 (export policy) is done and live

The handoff's third step — "remove only the editorial approval prerequisite from manual export,
preserve billing/access restrictions" — **merged as `b0e8000` and is running in production**
(PR #40).

- `POST /api/clips/:id/exports` no longer refuses with `APPROVAL_REQUIRED`.
- `isClipApprovedForPublish` / `publishApprovalBlockMessage` are the surviving publish-side authority.
- `requireApiWorkspace("EXPORT_CLIP")` still enforces role, trial expiry, and the lapsed read-only
  policy. A test asserts the publish message never says "export", so the two gates cannot be
  reconflated.
- Recorded in `DECISIONS.md` (2026-08-18) and marked done in P1.11/P2.4 of the implementation plan.

Gate 11 is therefore unblocked before any editor work begins, which is what the handoff wanted from
putting export policy early.

The publish-side half — composing `isClipApprovedForPublish` into delivery eligibility — stays
scheduled for P1.11. Automatic publishing is still globally disabled, so nothing can reach an
audience in the meantime regardless.

## 3. Both decisions are resolved (2026-08-20)

Each changed what gets built, so both are recorded in `DECISIONS.md` rather than left in this
plan alone.

### D1 — How pop clearance and collision-freedom coexist

Jake rejected the current behavior: every gap between words is permanently widened by the maximum
pop overshoot, so a Highlighter line looks spaced-out even when nothing is animating. He also
requires "keep words readable without collisions".

Those two requirements are in direct tension with the property that makes preview/export parity
cheap: each word is an absolutely positioned event that scales about its own center, so **nothing
moves when a word pops**. Static positions mean clearance must be reserved in advance or not at
all.

| Option | Behavior | Cost |
| --- | --- | --- |
| **A — Bounded overlap** | Lay words out at normal spacing. The active word scales about its center and is allowed to overlap its neighbours' *ink* by a bounded amount, kept legible by the Highlighter stroke and by capping `highlightScale`. | Cheapest. Risk: at large sizes or long adjacent words, "bounded" may still read as a collision. |
| **B — Neighbour micro-shift** | Neighbours of the active word slide outward and back, expressed as additional `\t(...\pos)` transforms so libass and the preview animate identically. Spacing is normal whenever nothing is active. | Exactly the requested behavior. Cost: roughly triples caption event count, and re-introduces controlled motion that the original design deliberately removed. Needs a real render to confirm libass keeps it smooth. |
| **C — Per-gap clearance** | Reserve clearance only in the gaps either side of each word, sized from that word's own width instead of the row maximum. Spacing is still static but much tighter and no longer uniform. | Middle cost. Does not fully satisfy "completed words return to normal spacing"; it narrows the gap rather than removing it. |

**Resolved: B — neighbour micro-shift.** The active word gets space sized to its current pop, its
neighbours move slightly aside and return, and spacing is never permanently widened. It ships as
its own slice (slice 8) with preview/export parity and one real render test, exactly because it
is the option that can destabilise the parity property the caption pipeline rests on.

One constraint discovered while writing this up, which shapes the slice: **libass `\t` cannot
animate `\pos`.** Position animates only through `\move`, which is a single linear motion per
Dialogue event with no acceleration parameter. So a neighbour moving out and back cannot be one
transform — it has to be split across events, and its motion is linear while the active word's
scale stays accelerated. The preview must therefore interpolate neighbour offsets linearly while
interpolating the pop itself on the shared curve. Event count per word rises from at most three to
roughly seven to nine, since every word is a neighbour twice as well as active once.

If the real render shows the split-event motion is not smooth, the recorded fallback is a stepped
shift — neighbour jumps aside for the pop and back afterwards, no interpolation.

### D2 — Where timeline video thumbnails come from

Jake saw "only a blue strip". The prototype extracts frames in the browser by seeking a `<video>`
element and drawing to a canvas — which is exactly the technique that yields blank or single-colour
frames when seeks land before a decodable frame, and which cannot be made reliable across browsers.

| Option | Behavior | Cost |
| --- | --- | --- |
| **A — Worker-generated filmstrip** | The worker produces a sprite sheet for the source once, registers it as a retained derived artifact, and the timeline just displays it. | Reliable. This is `timeline_view` from the P4 milestone, so it borrows scope from a later phase and needs a storage key registered in retention (an unregistered key leaks forever). |
| **B — Harden the client extraction** | Wait for `seeked` plus a decoded frame, retry, fall back to a neutral placeholder rather than a blue field. | Cheap, no new storage, no retention question. Still browser-dependent and still costs the viewer bandwidth and CPU on a full sermon. |

**Resolved: B — hardened browser extraction now.** Wait for a decoded frame, retry a failed seek,
and show a neutral placeholder when extraction fails; a frame that cannot be produced must never
render as a plausible-looking wrong image. Worker-generated filmstrips stay P4 work, where the
storage key and its retention class are already accounted for.

## 4. Slice order

Each slice is one or more commits, small and by coherent behavior, each leaving tests green. Failing
behavior tests come first. The listed coverage is the minimum from the handoff.

The order below follows the handoff's suggested order with three changes, each justified in place:
export policy is removed (done), the case model is pulled forward out of two later slices, and
timeline media is split from timeline layout as the handoff's own commit guidance requires.

---

### Slice 1 — Instant preview, separated from coalesced persistence

**Why first:** every later slice adds controls, and each one would otherwise inherit the half-second
delay and the save races. Fixing the substrate once is cheaper than fixing it per control. The
handoff puts this first for the same reason.

**Behavior**

- Every visual control updates the preview on the local input event. No debounce sits between input
  and render.
- Persistence is a separate concern from preview. The document is marked dirty immediately.
- Releasing a slider or colour picker triggers an immediate save.
- Keyboard input saves after roughly 300 ms idle, and immediately on Enter or blur where that is the
  natural commit point.
- One drag produces one save, not one per frame.
- `Saved` appears only after the backend confirms the exact version that was saved. A save whose
  response is superseded never reports `Saved` for stale content.
- Manual "Save changes" stays.

**Coverage:** autosave coalescing; pointer-release save; stale-version conflict; reload persistence;
`Saved` is not shown for a superseded response.

**Commit boundary:** preview-path changes and persistence-path changes are separate commits, so a
regression in either is isolable. This is explicit in the handoff.

---

### Slice 2 — Undo, redo, and shortcut reliability

**Why here:** history has to be correct before controls start writing to it, and it depends on the
preview/persistence split from Slice 1 — grouping is defined by interaction boundaries, which only
exist once "one drag" is a distinct thing.

**Behavior**

- Undo, Redo, Command+Z, Command+Shift+Z, and the Windows equivalents work across caption,
  transcript, trim, title, and audio edits.
- One drag is one undo step, not one per frame.
- A remote or autosave-driven state sync never destroys the redo stack.

**Coverage:** history grouping; the Undo/Redo buttons; Mac and Windows shortcuts.

---

### Slice 3 — A shared text-case model

**Why here, not later:** the handoff asks for the same five case options in the caption controls
(Slice 7) and the title controls (Slice 9), and the current model has only a boolean `uppercase` on
captions and no case field at all on the title. Building it twice, or building it inside one of
those slices and retrofitting the other, is how the two drift apart. It is small and pure, so it
goes in early on its own.

**Behavior**

- Case is one shared, versioned notion: Uppercase, Sentence case, Title Case, lowercase, Original.
- Uppercase is the default for both captions and the title.
- Applying case is a pure function used by measurement, the browser preview, and the ASS generator,
  so all three agree on the string being laid out.
- Existing documents keep rendering: the old caption `uppercase` boolean maps to Uppercase or
  Original, and nothing else changes.

**Coverage:** every case option; the legacy boolean maps without changing any existing clip's
rendered text.

---

### Slice 4 — Playback, playhead, and transport correctness

**Why here:** independent of the canvas and the inspector, and it is what makes every later visual
change verifiable — you cannot judge caption timing without a playhead you can put where you want.

**Behavior**

- Clicking the timeline moves the red playhead to that exact time.
- The playhead is horizontally draggable.
- "Go to end" seeks to the clip end. It currently restarts the clip.
- Playback stops at the clip end and does not loop.
- "Back 3 seconds" and "Forward 3 seconds" exist, clamped to the clip bounds.
- The large centre Play icon is hidden while the video plays, and never covers a centred caption.
- The video surface stays clickable to toggle play and pause.

**Coverage:** playhead click and drag; start, end, and ±3-second bounds; playback stops at clip end.

---

### Slice 5 — Transcript behavior

**Why here:** depends on Slice 4 for seeking and Slice 1 for commit-on-Enter semantics.

**Behavior**

- Clicking a transcript word seeks to that word's exact timestamp.
- The selected word is directly editable in place. The old large selected-word action box is gone.
- Enter commits the word once and exits editing; the caret disappears immediately.
- Clicking or editing a word never cuts the clip. (The clip is one continuous range — see the
  2026-08-13 P1.4/P1.5 decision.)
- The transcript range follows both trim handles, including when a trim **extends** the clip.

**Coverage:** transcript expands and contracts with trim; word click seeks exactly; Enter commits
once and leaves editing.

---

### Slice 6 — Direct-manipulation canvas

**Why here:** needs Slice 1's instant preview to feel like manipulation rather than lag, and Slice 2
so a drag is one undo step.

**Behavior**

- A selected caption shows one thin border and four corner handles. No "ALL CAPTIONS — DRAG" label.
- Captions drag, drop, and corner-resize directly.
- Clicking outside clears the selection and removes the border and handles.
- Horizontal-centre snapping with a visible centre guide.
- Social safe-zone guides are visible while editing and never rendered into an export.
- Mobile: pinch-to-zoom on the editing canvas, separate from timeline zoom; two-finger pan while
  zoomed; a fast reset to 100%.
- Canvas zoom and pan change only the view. They never alter persisted overlay coordinates or the
  exported layout, and they never block direct dragging of a caption or title.

**Coverage:** deselection; snapping; safe guides; canvas-only mobile zoom — specifically, that zoom
and pan leave the persisted document byte-identical.

---

### Slice 7 — Caption control cleanup and highlight correctness

**Depends on:** Slice 3 (case model), Slice 6 (direct manipulation replaces the X/Y inputs).

**Behavior**

- Font moves into the main Captions section, out of Advanced styling.
- Weight becomes a slider with a paired number field.
- X and Y position inputs are removed; direct manipulation is the position control.
- The Advanced styling disclosure gets a chevron and clear expand/collapse language.
- Every numeric slider also accepts direct number input, and the two stay synchronised.
- Case selection appears, defaulting to Uppercase.
- Exactly one word is highlighted at every timestamp — never two.
- Words are laid out at **rest spacing**: the permanent maximum-pop clearance is removed here.
  Until slice 8 lands, an active word will overlap slightly at large sizes. That is a deliberate,
  short-lived intermediate state — the alternative is holding the whole control cleanup behind the
  motion work.

**Coverage:** a line with no active word is spaced at rest, never at the maximum pop value;
exactly one highlighted word at every timestamp across a transcript with deliberately overlapping
source intervals; slider and number field stay in sync.

**Note on word timing:** "word timing must match the spoken word precisely" is bounded by transcript
quality, not by this editor. Native whisper.cpp word starts differ from forced alignment by a median
of about 203 ms; Scribe's medians sit around 15 ms against the same reference. Scribe is now the
active primary provider (PR #39), so sermons transcribed from here on carry the better timing —
but clips built on an older whisper.cpp transcript keep theirs until the sermon is re-transcribed.
If timing still reads as imprecise after this slice, check which provider produced that
transcript before changing any editor code.

---

### Slice 8 — Active-word neighbour micro-shift

**Depends on:** Slice 7. Its own slice by decision (D1), because it is the one change that can
destabilise preview/export parity, and it must not be able to take the control cleanup down with
it.

**Re-scoped 2026-08-21 against the verified baseline (§1).** This slice was sized on the belief
that caption layout was already measured once and shared by both renderers. It is not. Nothing on
`origin/main` knows a word's width: the preview lets CSS lay out inline-blocks, and the burn-in
hands libass one Dialogue per phase carrying the whole run. A neighbour cannot move aside by an
amount nobody has computed, and the preview and the file cannot agree on an offset neither can
state. So before any word moves, this slice has to create the measurement layer the original
plan assumed was there.

**What Slice 7 gives this slice, verified:** `captionActivations` (one selector for which line,
which words, which stretch, on the centisecond grid), `popClock` and `popPhases` (the activation's
clock and its phases), `popScaleAt` (the preview's evaluation), `popPhaseTags` (the file's), and
the bundled faces in `public/fonts` served to the browser and installed in the worker image, so
the same TTF is on both sides to be measured.

**What must be created, not wired:**

- `src/lib/editor/caption-layout.ts` — a pure layout: given a line's words, a measurer, the
  style and the active word, return each word's rest position and its shifted position. One
  function, one rule, no DOM and no fonts in it; both renderers call it.
- A server-side measurer over the bundled TTFs for the burn-in (the prototype used `fontkit`;
  `origin/main` has no font-parsing dependency, so one must be chosen and added). The build gate
  that already checks `fc-match` resolves each family to a bundled file is the right place to
  also prove the measurer opens the same file.
- A browser measurer over the same faces for the preview, which must not report a width until
  `document.fonts.ready` — Slice 7 measured the fallback's metrics once (234.77px against
  258.44px) and paid for it.
- Per-word positioning in the ASS generator. Today a Dialogue event carries the whole run and
  libass positions it; a neighbour that moves needs its own event with its own `\pos` or `\move`.
  That is a restructuring of how caption events are emitted, not an addition to it.

**Behavior**

- When a word becomes active, its immediate neighbours move slightly aside for the duration of the
  pop and return to rest afterwards.
- Spacing at rest is never widened. A line with nothing active looks exactly as it did after
  slice 7.
- Popped words never overlap their neighbours' ink.
- The browser preview and the burned-in render produce the same motion at the same times.

**The constraint that shapes this slice.** libass `\t` cannot animate `\pos`; position animates
only through `\move`, one linear motion per Dialogue event, with no acceleration parameter. So a
neighbour moving out and back is not one transform — it is split across events, and its motion is
linear while the active word's scale stays on the accelerated pop curve. The preview must
interpolate neighbour offsets linearly to match, while still interpolating the pop itself on the
shared curve. Expect event count per word to rise from at most three to roughly seven to nine,
because every word is a neighbour twice as well as being active once.

**Fallback, decided in advance:** if the real render shows the split-event motion is not smooth,
retreat to a stepped shift — the neighbour jumps aside for the pop and back afterwards, with no
interpolation. Recorded so the retreat is a decision rather than a surprise.

**Risks the re-scope adds.** Two measurers over one file can still disagree — hinting, kerning,
subpixel rounding, and the browser's own layout of an inline-block are each a source of a
fraction of a pixel, and a fraction of a pixel is an overlap the frame sampler will catch. The
acceptance test therefore measures both sides against the same fixture line in the same face and
states the tolerance, before any motion is attempted. The second risk is the event restructuring:
once words are positioned individually, legacy presets must still emit exactly what they emit
today — the parity tests that guard Clean's timings are the regression net, and a byte-identical
ASS fixture for a legacy preset should be added before the generator is touched.

**Coverage**

- Rest spacing is unchanged from slice 7 — the micro-shift adds no permanent width.
- No two rendered words overlap at any sampled frame across a pop.
- Preview and ASS agree on every neighbour offset at sampled timestamps.
- **One real ffmpeg render**, not a unit test: burn a Highlighter line, sample frames across a
  pop, and confirm the motion is smooth and collision-free. This is the acceptance gate.
- Event count for a representative line stays within the budget the render proves affordable.
- *Added:* the browser measurer and the server measurer agree on every word of the fixture line
  within a stated tolerance, after `document.fonts.ready`.
- *Added:* a legacy preset's ASS output is byte-identical before and after the per-word event
  restructuring.
- *Added:* browser coverage through the real `VideoPreview`, not only the pure layout function.

**Size.** Originally one slice of motion work. Now two stages that must land in order — the
shared measured layout with its parity test, then the motion — and the first stage is the larger
of the two. Plan for roughly double the original estimate, with the measurement stage as its own
reviewable commit series so a parity problem stops there rather than inside the animation.

---

### Slice 9 — Title overlay defaults and live preview

**Depends on:** Slice 3 (case), Slice 6 (drag, resize, snapping), Slice 1 (no debounce).

**Re-scoped 2026-08-21 against the verified baseline (§1).** This slice was written as defaults
and live preview over an existing title-banner model. There is no model. `EditorState.overlays`
is `z.array(z.unknown())`; the only overlay anything writes is the brand template's
`{ type: "lowerThird" }`, and the only overlay the burn-in draws is that lower third. "Top Safe"
also names a safe-area datum that does not exist — the canvas guides are inline CSS percentages
with no data behind them. The product behaviour below stands; the slice now includes building
the thing the behaviour is about.

**What Slice 6 and Slice 7 give this slice, verified:** `CanvasObject` (drag, corner-resize,
centre snap with a visible guide, labelled by prop and not caption-specific), the instant-preview
/ coalesced-save split, the shared case model, and `captionActivations` as the pattern for a
single selector both renderers read.

**What must be created, not wired:**

- `src/lib/editor/title-banner.ts` — the overlay type, its defaults (first three seconds, Top
  Safe, horizontally centred, centre-aligned, uppercase black on white, no border, no shadow), and
  pure `read`, `upsert`, `remove`, `dismiss` and `ensureDefault` helpers over `overlays`. The
  `overlays` schema must gain a discriminated title type without invalidating stored documents
  that carry only a lower third or nothing.
- **One shared safe-area datum** — the anchor vocabulary (`top-safe`, `center`, `bottom-safe`,
  `custom`) and the bounds, as versioned data — that **every consumer reads**: the existing
  canvas guide (which today hard-codes its percentages in CSS), caption preview placement, title
  placement in the preview, and caption and title placement in the ASS export. Four consumers,
  one source. A guide drawn from one number and a title placed by another is the drift this plan
  exists to prevent, so none of them keeps a private copy.
- The Title track in the timeline, with region drag and start/end trim.
- The Title settings panel, and the track-to-panel switching the behaviour bullets describe.
- The title in the burn-in. A title the preview shows and the export omits is the defect this
  whole plan exists to prevent, so the ASS generator draws it from the same model, in the same
  face, at the same position and time.
- **A bundled title face.** The title's font is selected from `BUNDLED_CAPTION_FONTS` (or a face
  added to `public/fonts` under the same rules), served by `@font-face` and installed in the
  worker image, and the worker-image build gate that already requires `fc-match` to resolve each
  caption family to a bundled file is extended to the title face. A title drawn in a face the
  browser has and the worker does not is a parity failure the gate exists to catch at build time.

**Behavior**

- A new title defaults to the first three seconds of the clip, Top Safe, horizontally centred,
  centre-aligned text, uppercase black text on a white background, no border, no shadow.
- The title drags, drops, corner-resizes, and snaps to horizontal centre with a visible guide.
- The Title track supports dragging the region and trimming its start and end.
- X removes the title. Selecting the empty Title track recreates the default three-second title.
- Clicking Title opens Title settings; Video returns to Caption Style; Audio opens Audio settings.
  (This track switching passed manual review — do not change it.)
- Every title slider, alignment button, and colour control updates the preview continuously and
  immediately, including while dragging through a colour picker.
- Horizontal and vertical position readouts update continuously while the title is dragged.

**Risks the re-scope adds.** The schema change touches every stored document: `overlays` has
been `unknown[]` since the beginning, and a stricter parser that rejects an old shape would stop
clips loading. Parse leniently, write strictly. The second risk is a second renderer disagreement
of the kind Slice 7 spent five rounds on: the title has its own face, case and position, and each
is a place the preview and the file can drift. Reuse the centisecond grid and the single-selector
pattern from the start rather than discovering the need for them afterwards.

**Coverage:** title defaults; continuous control updates; recreate-after-remove. *Added:* old
documents with no title, or only a lower third, still parse and render as before. *Added, title
parity:* at sampled timestamps the preview and the ASS output agree on time, position, text,
**font, size, weight, case, alignment, background, border, shadow, and box dimensions** — each
one a property the two renderers can drift on, each one asserted, none inferred from another.
*Added, safe-area parity:* the guide, the caption preview, the title preview, and the ASS export
each read the shared datum, with a test per consumer proving that changing the datum moves all
four and that none carries a private copy. *Added:* the worker-image font gate fails when the
title face is not resolvable to a bundled file. *Added:* browser coverage through the real canvas
for drag, resize, snap and the track switching.

**Size.** Originally a defaults-and-polish slice. Now a model, a schema migration in the lenient
sense, a track, a panel and a burn-in path as well. Plan for roughly three times the original
estimate, and land the model and burn-in before the panel so parity is proven before the controls
exist to break it.

---

### Slice 10 — Timeline layout

**Split from Slice 11 deliberately** — the handoff requires timeline media generation to be separate
from timeline layout.

**Behavior**

- Title, Video, and Audio rows are always shown separately.
- No word-pill row.
- 15 seconds of unused source before and after the active clip by default, clamped to real media
  bounds.
- Timeline zoom exposes more or less of the source. It does not change trim limits.
- Trim handles stay limited by the real source boundaries.
- Transport controls stay centred above the tracks.

**Coverage:** the 15-second context with source-boundary clamps; zoom does not move trim limits.

---

### Slice 11 — Timeline media evidence

**Depends on:** Slice 10. Resolved by D2: hardened browser extraction now, worker filmstrips at P4.

**Behavior**

- The Video row shows reliable, recognisable frames from the source. No blue strip, and no silent
  blank frame — a frame that cannot be produced shows a neutral placeholder, not a wrong image.
- The Audio row shows real audio-amplitude peaks, replacing the transcript-derived pseudo-waveform,
  with higher contrast and legibility.

**Coverage:** peaks derive from audio rather than from transcript word density; a failed frame
extraction produces a placeholder rather than a misleading solid colour.

---

### Slice 12 — Shell and header polish

**Why last among the build slices:** purely presentational, and it touches the file with the
protected billing block. Doing it last keeps that risk away from every functional slice.

**Behavior**

- Centred red headings above each area: `Transcript`, `Video`, `Style`, `Timeline`.
- The black, white, and red visual system stays.
- A generated clip title of at most five words, editable.
- Draggable dividers between Transcript/Video and Video/Style, with min and max widths enforced.
- The video stays visually centred while either side panel changes width.
- Header actions stay: Back to clips, title, save status, Undo, Redo, Save changes, Export MP4.
- The Export tab/button leaves the Style inspector. The header Export MP4 button is the only export
  entry point.
- Every editor button has a short hover description.

**Hard constraint:** the billing-state badge in the app shell is not touched by this slice or any
other. It now resolves through an exhaustive `workspaceAccessLabel` switch, so dropping a state is a
compile error; do not reintroduce an inline conditional there.

---

### Slice 13 — Export parity and final QA

**Behavior**

- One real MP4 export, verified against the preview state: trim, caption words, caption timing,
  style, position, title style, position and timing, and audio volume.
- No selection handles, safe-zone guides, centre guides, or editor controls appear in the MP4.
- The output is a valid 9:16 MP4.
- Re-run only the rejected gates plus Gate 11.
- Playwright coverage is added **after** Jake approves the final UI, so the selectors are written
  once.
- `npm run verify`, the worker build, and the worker font gate all pass.

**Coverage:** preview/export parity for captions, title, trim, and audio volume; manual export
without editorial approval while billing and access restrictions stay enforced.

---

## 5. Sequencing summary

```
Slice 1  preview / persistence split      ── foundation
Slice 2  undo, redo, shortcuts            ── needs 1
Slice 3  shared case model                ── independent, pulled early
Slice 4  playback and playhead            ── independent
Slice 5  transcript                       ── needs 1, 4
Slice 6  direct-manipulation canvas       ── needs 1, 2
Slice 7  caption controls + highlighting  ── needs 3, 6
Slice 8  neighbour micro-shift            ── needs 7; own slice; real render is the gate
Slice 9  title defaults and live preview  ── needs 1, 3, 6
Slice 10 timeline layout                  ── needs 4
Slice 11 timeline media                   ── needs 10
Slice 12 shell and header polish          ── last; touches the protected file's neighbourhood
Slice 13 export parity and final QA       ── needs everything
```

Corrected 2026-08-21: Slices 8 and 9 each begin by creating modules the original §1 said already
existed (measured caption layout; the title-banner model and a safe-area datum). Their order and
dependencies above are unchanged; their size is not — see each slice.

## 6. Rules that hold across every slice

- Small commits by coherent behavior. Each leaves the relevant tests green.
- Failing behavior tests first.
- Instant-preview changes stay in different commits from backend autosave changes.
- Timeline media generation stays in different commits from timeline layout.
- The protected app-shell billing block is never mixed with editor work.
- Unrelated dirty-worktree changes are neither committed nor discarded.
- Some tests deliberately record known defects as executable evidence — Sunday-spill scheduling,
  destructive reanalysis, the Stage A funnel ratio, and the opening-quarter clip assertion. They
  belong to P1.7, P1.8, P1.9, P0.17, and P5. Do not "fix" them.

## 7. What this plan does not cover

- **P1.1 is done; P1.2 and P1.3 remain outstanding.** *(Corrected 2026-08-21; the paragraph
  below replaces the earlier statement that both halves of P1.1 were missing.)* P1.1 (render an
  explicitly pinned edit version) landed in PR #42 (`62815d2`, merged `9c0e8fc`, 2026-08-20),
  verified on `origin/main` at `276d3fd`:

  - **The version is written.** The exports route stores `editVersion` on the `ExportJob` row
    (`src/app/api/clips/[id]/exports/route.ts`), as well as using it in the idempotency key
    (`export:<clip>:v<version>:<filename>`).
  - **The version is read.** `runExportJob` loads the document through `loadPinnedEditorState`
    with `job.editVersion` (`src/lib/exports/handler.ts`), so a job renders the edit it was asked
    for even when newer edits were saved between the request and the run.

  The earlier concern stands as history: removing the export approval gate removed an accidental
  brake, and without the pin a queued export could have rendered a newer edit than the one
  requested. The pin closes that window.
- **Transcription provider activation.** Done and live (PR #39, merged `c278b39`): Scribe v2 is
  the primary provider in production with whisper.cpp secondary. One consequence reaches the
  editor — a sermon that fell back to whisper.cpp puts an editorial hold on its project, so those
  clips stay fully editable but the automatic publisher will not send them until a person clears
  the hold. Nothing in slices 1–13 changes that.
- **The P4 sermon-boundary corridor**, now an efficiency improvement rather than a gate. Until it
  lands, a full service reaches paid transcription as full-service audio, and every run records
  the submitted duration so that cost stays measured.
