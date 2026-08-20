# Editor Delta Implementation Plan — 2026-08-18

Source: `MOZI_REDESIGN_1_0_CLAUDE_HANDOFF_2026-08-17.md` (Jake's manual review of the redesigned
editor: 11 gates, 8 rejected, 1 blocked, 2 approved).

This plan describes behavior, not line numbers, so it survives the rebase of the editor prototype.
It is a **delta** against the prototype recorded on branch `p1/kinetic-captions-and-editor`, whose
final commit is labelled `PROTOTYPE, NOT ACCEPTED`.

**Status (2026-08-20): awaiting two answers, not approval of the whole plan.** Slices 1–6, 8, 9 and
11 are ready to start. Slice 7 needs decision **D1** and slice 10 needs decision **D2** (§3), and
neither is an implementation detail — each changes what gets built.

Ahead of the slices, two pieces of the surrounding work have landed in production and are no
longer pending: the export-policy step (§2) and the Scribe provider activation (§7).

The prototype branch `p1/kinetic-captions-and-editor` is still unmerged, and its final commit is
still labelled `PROTOTYPE, NOT ACCEPTED`. It has not been reviewed and should not be, until this
plan is settled — the slices below are what turn it into something worth reviewing.

---

## 1. What the baseline already gives us

Worth knowing before reading the slices, because several handoff requirements are already met at
the model layer and only need wiring or correction.

| Already true in the baseline | Where it lives |
| --- | --- |
| Exactly one active caption word is derivable at any timestamp, even when source word intervals overlap | `activeCaptionWordId`, `exclusiveCaptionWordEnds` |
| The pop curve is one shared definition that the browser preview and the ASS generator both evaluate | `caption-animation.ts` |
| Caption line layout is measured once and consumed by both renderers | `caption-layout.ts`, `font-metrics.ts`, `use-text-measurer.ts` |
| Only Clean and Highlighter are offered; Clean does not animate; Highlighter is neon yellow, bottom-safe, word-by-word | `caption-presets.ts` |
| A versioned social safe area exists as data | `social-safe-area.ts` |
| Panel min/max widths and a video minimum are already computed | `panel-resize.ts` |
| Undo/redo with grouping is already a pure reducer | `document-history.ts` |
| A title-banner overlay model with defaults, upsert, remove, and dismiss | `title-banner.ts` |
| Manual export no longer requires editorial approval, with billing and access untouched | landed — see §2 |

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

## 3. Two decisions Jake must make before the slices that depend on them

These are not implementation details. Each one changes what gets built.

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

**Recommendation: A, with C as the fallback if a real render shows collisions.** B is the only
option that literally matches the wording, and it is the one that can destabilise the parity
property the whole caption pipeline rests on. If Jake wants B, it should be its own slice with its
own render proof, not folded into the caption-control cleanup.

### D2 — Where timeline video thumbnails come from

Jake saw "only a blue strip". The prototype extracts frames in the browser by seeking a `<video>`
element and drawing to a canvas — which is exactly the technique that yields blank or single-colour
frames when seeks land before a decodable frame, and which cannot be made reliable across browsers.

| Option | Behavior | Cost |
| --- | --- | --- |
| **A — Worker-generated filmstrip** | The worker produces a sprite sheet for the source once, registers it as a retained derived artifact, and the timeline just displays it. | Reliable. This is `timeline_view` from the P4 milestone, so it borrows scope from a later phase and needs a storage key registered in retention (an unregistered key leaks forever). |
| **B — Harden the client extraction** | Wait for `seeked` plus a decoded frame, retry, fall back to a neutral placeholder rather than a blue field. | Cheap, no new storage, no retention question. Still browser-dependent and still costs the viewer bandwidth and CPU on a full sermon. |

**Recommendation: B now, A when P4 lands.** B removes the defect Jake actually saw without pulling
a storage-retention decision into a UI slice. If Jake would rather do A once, this becomes a
cross-phase slice and the plan grows a dependency on the P4 derived-artifact work.

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
(Slice 6) and the title controls (Slice 7), and the current model has only a boolean `uppercase` on
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

**Depends on:** Slice 3 (case model), Slice 6 (direct manipulation replaces the X/Y inputs), and
decision **D1**.

**Behavior**

- Font moves into the main Captions section, out of Advanced styling.
- Weight becomes a slider with a paired number field.
- X and Y position inputs are removed; direct manipulation is the position control.
- The Advanced styling disclosure gets a chevron and clear expand/collapse language.
- Every numeric slider also accepts direct number input, and the two stay synchronised.
- Case selection appears, defaulting to Uppercase.
- Exactly one word is highlighted at every timestamp — never two.
- Pop clearance behaves per decision D1. Whatever D1 selects, the acceptance test is the same:
  a line with no active word must not be spaced for the maximum pop value.

**Coverage:** active-only pop spacing; exactly one highlighted word at every timestamp across a
transcript with deliberately overlapping source intervals; slider and number field stay in sync.

**Note on word timing:** "word timing must match the spoken word precisely" is bounded by transcript
quality, not by this editor. Native whisper.cpp word starts differ from forced alignment by a median
of about 203 ms; Scribe's medians sit around 15 ms against the same reference. Scribe is now the
active primary provider (PR #39), so sermons transcribed from here on carry the better timing —
but clips built on an older whisper.cpp transcript keep theirs until the sermon is re-transcribed.
If timing still reads as imprecise after this slice, check which provider produced that
transcript before changing any editor code.

---

### Slice 8 — Title overlay defaults and live preview

**Depends on:** Slice 3 (case), Slice 6 (drag, resize, snapping), Slice 1 (no debounce).

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

**Coverage:** title defaults; continuous control updates; recreate-after-remove.

---

### Slice 9 — Timeline layout

**Split from Slice 10 deliberately** — the handoff requires timeline media generation to be separate
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

### Slice 10 — Timeline media evidence

**Depends on:** decision **D2**.

**Behavior**

- The Video row shows reliable, recognisable frames from the source. No blue strip, and no silent
  blank frame — a frame that cannot be produced shows a neutral placeholder, not a wrong image.
- The Audio row shows real audio-amplitude peaks, replacing the transcript-derived pseudo-waveform,
  with higher contrast and legibility.

**Coverage:** peaks derive from audio rather than from transcript word density; a failed frame
extraction produces a placeholder rather than a misleading solid colour.

---

### Slice 11 — Shell and header polish

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

### Slice 12 — Export parity and final QA

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
Slice 7  caption controls + highlighting  ── needs 3, 6, decision D1
Slice 8  title defaults and live preview  ── needs 1, 3, 6
Slice 9  timeline layout                  ── needs 4
Slice 10 timeline media                   ── needs 9, decision D2
Slice 11 shell and header polish          ── last; touches the protected file's neighbourhood
Slice 12 export parity and final QA       ── needs everything
```

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

- **P1.1, P1.2, P1.3** remain outstanding. P1.1 (render an explicitly pinned edit version) is two
  changes, not one, and both are still missing on `main`:

  - **Nothing writes the version.** `ExportJob.editVersion` exists in the schema, but the exports
    route computes the version only to build the idempotency key
    (`export:<clip>:v<version>:<filename>`) and never stores it on the row.
  - **Nothing reads it.** `runExportJob` resolves the newest `ClipEdit` by `version desc` and
    makes no reference to `job.editVersion` at all.

  Removing the export approval gate made this more pressing, not less. Approval used to be an
  accidental brake: an editor save demoted an approved clip to DRAFT, which blocked the next
  export until someone re-approved, so the window in which a queued job could be rendered from a
  newer edit was small. Now a member can edit and export immediately, and the render takes
  whichever edit is newest when the worker picks the job up. Nothing is corrupted — the output is
  a real saved edit — but it can be a different edit than the one the export was asked for, and
  the idempotency key will still claim it was the older version.
- **Transcription provider activation.** Done and live (PR #39, merged `c278b39`): Scribe v2 is
  the primary provider in production with whisper.cpp secondary. One consequence reaches the
  editor — a sermon that fell back to whisper.cpp puts an editorial hold on its project, so those
  clips stay fully editable but the automatic publisher will not send them until a person clears
  the hold. Nothing in slices 1–12 changes that.
- **The P4 sermon-boundary corridor**, now an efficiency improvement rather than a gate. Until it
  lands, a full service reaches paid transcription as full-service audio, and every run records
  the submitted duration so that cost stays measured.
