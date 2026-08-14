# Labeled Benchmark — Labeling Guide v1

**Purpose.** A benchmark manifest records one human-labeled service: where the sermon is, where
forbidden service content is, and how the operator judged each candidate clip. These manifests are
the offline evidence that every later phase is measured against — detector recall, selector quality,
and agent agreement all score against them.

**Authority.** `docs/PULPIT_ENGINE_EDITORIAL_STANDARD.md` defines what a clip is allowed to be. This
guide only explains how to write that judgment down. Where they disagree, the standard governs.

---

## 1. Never commit church media

Manifests live in this repository. Sermon video does not.

A manifest references its source by an opaque `artifactId` and a `sha256` checksum. The validator
rejects any manifest containing a file path, a URL, or a media filename — in any field, including
free-text notes. This is enforced, not advisory:

```
npm run verify:benchmark
```

Keep the media itself in the operator's controlled storage. The checksum is what proves a later run
used the same bytes.

## 2. Files

| File | Role |
|---|---|
| `benchmark-manifest.schema.json` | Published JSON Schema. **Generated** — do not hand-edit. |
| `benchmark-manifest.example.json` | A complete worked example, validated in CI. |
| `*.json` (yours) | One manifest per labeled service. |

The schema is generated from `src/lib/evaluation/benchmark-manifest.ts`, which is the single source
of truth. Regenerate after changing that module:

```
npm run verify:benchmark -- --write-schema
```

A stale committed schema fails validation, so the two cannot drift apart silently.

## 3. Labeling regions

Regions are **facts about the media**, not editorial decisions. Label what is there; the policy that
acts on it lives in versioned code and may change without relabeling.

| Kind | Label when |
|---|---|
| `SERMON` | The pastor is preaching the message. Label the whole span, start to end. |
| `WORSHIP` | Music, singing, or instrumental worship. |
| `ANNOUNCEMENT` | Series promos, events, giving, welcome segments. |
| `PRAYER` | Corporate or closing prayer. |
| `BAPTISM` | Baptisms and related testimony. |
| `OTHER_SERVICE_CONTENT` | Anything else that is not the sermon. |
| `PASTOR_VISIBLE` | The speaker is on camera and identifiable. |
| `FULLSCREEN_SLIDE` | A slide covers the frame and the speaker is not visible. |
| `AMBIGUOUS` | You genuinely cannot tell. Use it — do not guess. |

Regions may overlap. `PASTOR_VISIBLE` will usually span most of `SERMON`, and a `FULLSCREEN_SLIDE`
will sit inside it. That is expected and correct.

Notes to keep labeling consistent:

- Label the **whole** sermon span, not just the good parts. Coverage is what makes recall
  measurable.
- A slide showing a face, a photograph of a person, or a video of the pastor is still a
  `FULLSCREEN_SLIDE` if it replaces the live shot. Detectors must learn this distinction.
- `AMBIGUOUS` is a real answer. A benchmark full of confident guesses teaches the system to guess.

## 4. Labeling candidates

A candidate is one continuous range you judged. Record the range, the decision, and any feedback.

**One range per candidate.** There is no way to express a multi-range clip, by design — the
continuous-source rule means an internal cut is not a thing the product can do, so it is not a thing
the benchmark can describe.

### Decisions

| Decision | Meaning |
|---|---|
| `ACCEPT` | Deliverable exactly as-is. |
| `REVISE` | The right moment, fixable by re-editing this clip. |
| `REPLACE` | The wrong moment. Fixing it would require different source material. |

### Feedback categories

| Category | Actionability |
|---|---|
| `CONTENT` | Replace-only |
| `FORBIDDEN_CONTENT` | Replace-only |
| `BOUNDARY` | Revisable |
| `VISUAL_CROP` | Revisable |
| `CAPTION` | Revisable |
| `AUDIO_LEVEL` | Revisable |

Severity is `MINOR`, `MAJOR`, or `CRITICAL`.

### Rules the validator enforces

These are contradictions, not style preferences, and each one fails validation:

1. `REVISE` cannot cite `CONTENT` or `FORBIDDEN_CONTENT`. If the content is wrong, re-editing cannot
   fix it — that is a `REPLACE`.
2. `ACCEPT` cannot carry `CRITICAL` feedback. A clip with a critical defect is not deliverable.
3. `ACCEPT` cannot overlap `WORSHIP`, `ANNOUNCEMENT`, `PRAYER`, `BAPTISM`, or
   `OTHER_SERVICE_CONTENT`.
4. `ACCEPT` cannot contain a `FULLSCREEN_SLIDE` **inside** its range. A slide touching the very edge
   is allowed, because a boundary move can exclude it; an interior slide cannot be removed without
   an internal cut.
5. Every range must fall inside the source duration, and end after it starts.
6. Candidate ids must be unique.

Rules 3 and 4 mean your region labels and your candidate decisions check each other. If validation
fails on one of them, one of the two is wrong — resolve it rather than working around it.

## 5. What makes a benchmark useful

Coverage matters more than volume. A corpus that is all clean Sunday services with a well-lit
pastor teaches nothing about the hard cases. Aim to include:

- One-service and two-service churches, in different timezones and on different weekdays
- Wide stage shots and tight speaker shots
- Multiple speakers, and guest preachers
- Worship with talking between songs
- Announcements, prayer, baptisms, altar calls
- Scripture slides, title slides, point slides, transition slides
- Short slides at a clip edge, and slides that sit mid-thought
- A slide containing a photograph of a person
- Camera cuts, black frames, freeze frames
- Noisy, reverberant, and quiet audio
- Naturally clean delivery **and** naturally poor delivery

Include services where the honest answer is "there are only two good clips here." A benchmark that
only contains successes cannot measure the failure the product actually has.

## 6. Recording a decision you are unsure about

Label it, then say so in the note. Do not silently pick the tidier answer.

Self-consistency is measured later by re-labeling a sample of past services blind, at least two
weeks apart. That number becomes the bar the agent is compared against — so an honest, slightly
inconsistent human record is more useful than a tidied one.
