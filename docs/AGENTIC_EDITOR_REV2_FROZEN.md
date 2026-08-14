# Agentic Editor — Frozen Architecture (Revision 2 + Addendum)

**Status:** Frozen 2026-08-11. This is the architecture of record for the agentic-editor program.

**Authority order.** Product-owner decisions take precedence, then this document, then
`docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md`. Editorial rules live in
`docs/PULPIT_ENGINE_EDITORIAL_STANDARD.md` and govern all three.

**Scope note.** This repository copy covers the P0–P4 architecture. The P5 Selector policy and P6
Review Agent design are withheld while the repository is public — see the 2026-08-11 decision entry
"Repository Stays Public Until P5". Their absence here is deliberate, not an omission.

---

## 1. The problem this program solves

The pipeline can find transcript passages and render clips. It cannot yet prove that a delivered
clip is tied to the exact reviewed edit, free of forbidden service content, visually usable, or good
enough to publish without a human. It also has no per-service cost truth.

Adding an autonomous agent on top of those gaps would produce unsafe delivery and corrupt training
data. An agent cannot learn from review decisions if the system cannot prove which edit produced the
reviewed file.

## 2. The approach

Keep the existing processing and rendering boundaries. Add exact provenance, continuous-source
enforcement, a low-cost derivative layer, a transcript-first selector, exact-render quality control,
and an evidence-gated review agent. Improve one global editorial policy from human review data.

Correctness first, then trustworthy human data, then agent authority — in that order, gated by
evidence rather than by calendar.

Do not fine-tune a model first. Deterministic rules, structured evidence, and good review labels
have a better cost-to-quality ratio than model training at this stage.

## 3. Phase order

| Phase | Purpose |
|---|---|
| P0 | Freeze policy, create evaluation data, add cost truth, remove unsafe defaults |
| P1 | Correct export provenance, scheduling, continuity, reanalysis, publishing |
| P2 | Build the human review substrate and start the fixed 30-day reference period |
| P3 | Complete candidate presentation and safe reserve replacement |
| P4 | Derivative-first sermon understanding and the media region index |
| P5 | Agentic selector, in shadow first |
| P6 | Exact-render quality control and the review agent |
| P7 | The fixed transition program and evidence-gated autonomy |
| P8 | Controlled policy improvement from trusted review data |

P0–P2 are authorized at full commit detail. P3 is fully planned. P4–P8 stay at milestone detail
until P0 measurements justify exact commit boundaries.

## 4. Components that do not change

Prisma and PostgreSQL. The processing-job queue and its reliability pattern. The separate export
queue. The storage-provider interface and R2-compatible object storage. FFmpeg and FFprobe. The
existing crop, caption, brand-template, and export modules. Workspace settings and project
`processingConfig`. Customer approval. The calendar and scheduled posts. The Facebook connection and
publisher. Operational events and alerts. The worker service. The timezone helpers. The `ANALYZE`
job seam. The drag-to-trim timeline and its boundary math.

These need focused correction, not replacement.

## 5. Components that change

- Export jobs must pin an exact edit version.
- Every deliverable edit must be one continuous source range.
- Reanalysis must not destroy review, export, or publication history.
- Scheduling must use configured weekdays, exclude Sunday, and use explicit slot states.
- Publishing must go through one fail-closed eligibility module bound to the slot's exact export.
- The transcript must carry speakers, pauses, audio events, sentence and paragraph boundaries,
  capability status, and provenance.
- Visual facts must be stored as source-level media regions that survive reanalysis.
- Analysis must never silently degrade to a non-production provider.
- Final renders must receive deterministic and then subjective review.
- Every paid and local stage must report cost, including which provider and model actually ran.

## 6. Standing architectural rules

**Media.** Never move, analyze, render, or store the full source video when a smaller derivative
will do. One acquisition per service. Compressed audio and an enriched transcript carry most
analysis. One shared uncropped 480p proxy serves candidate playback. Final MP4 files are rendered
only for scheduled or promoted clips. Reserve candidates do not get their own renders.

**Provenance.** Nothing publishes unless one module proves the exact export, edit version, checksum,
review, optional customer approval, slot state, and program state are all eligible. There is no
"latest successful export" path. A slot is bound to one export job.

**Fail-closed.** Ambiguity, budget exhaustion, provider failure, missing reserve, and indeterminate
external responses all route to a human exception queue. None of them degrade quietly. The heuristic
scorer is a development fallback and never a production path.

**Detection versus policy.** Detectors record facts and confidence about the media. Allow, avoid,
forbid, and salvage decisions live in versioned code, not in the detector output.

**Evidence over calendar.** Time never promotes the agent. Each transition requires its evidence
gate to pass and an explicit human promotion of a named policy version. Autonomy is reversible by
kill switch at any point.

**Learning hygiene.** Only human-audited decisions are trusted training labels. Agent-only decisions
never train the agent. Train and evaluation data split by church and by source service, with a
time-based holdout.

## 7. Economics shape

Per-church variable cost is dominated by transcription and payment processing, not by agent calls.
The agentic work adds roughly $1.04 per typical church per month. Source-video intake through a
residential proxy is the dominant cost risk and is unmeasured, so byte metering is a P0 gate.

The cost gates the code enforces are in the implementation plan §5.5. The hard limit is **$1.50 per
service** for core technical cost, excluding intake and payment fees.

Target pricing and margin analysis are held in the private planning copy.

## 8. What is explicitly rejected

Sending the complete service to a multimodal model. Rendering every retained candidate. Continuous
per-frame paid vision. Padding to a fixed candidate count. One backup row per primary clip. Internal
word or pause deletion. Church-specific editorial taste models. Silent fallback to a heuristic
ranker. Unlimited agent rerender loops. Time-only autonomy. Replacing the existing queue, storage,
render, or publishing systems wholesale. Fine-tuning before replay and held-out evidence justify it.

## 9. Out of scope for this product phase

Three or more services per week. Multi-range clips. Internal pause, filler, word, or phrase removal.
B-roll generation. AI-written replacement speech. Continuous full-service multimodal viewing. A
church-specific taste model. Automatic cross-project reserve borrowing. A full staff administration
dashboard. A broad rename of the `sermon-clipper` identifiers.
