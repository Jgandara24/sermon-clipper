# Pulpit Engine Agentic Editor — Corrected Commit-by-Commit Implementation Plan

**Status:** FINAL APPROVAL CANDIDATE — corrected after Codex review and Jake's answers. No implementation is authorized until Jake gives final approval.

**Date:** 2026-08-11

**Repository:** `/Users/jakegandara/Dropbox/ai-workspaces/sermon-clipper` (branch baseline: `feat/reel-builder-trim` @ `004db2f`)

**Architecture authority:** Jake's product-owner answers of 2026-08-10, including the final plan-correction response, take precedence. Rev 2 plus the binding addendum (`pulpit-engine-agentic-editor-v2-final-acceptance.md`) follows. This document folds all three in and becomes the build artifact only after Jake approves it.

**Verification provenance:** The full repository sweep was completed against the working tree on 2026-08-10 (branch `feat/reel-builder-trim`, including commits `a4b0ab6`, `c1603cd`, `004db2f`, which landed after the draft plan's repo sweep). The correction-sensitive schema, P3, Wave 1, repository-policy, and sandbox-evidence claims were rechecked on 2026-08-11. File and line citations refer to this branch state.

---

## 0.0 Build status (updated 2026-09-05)

P0 is merged (`331dbc5`, PR #34). The pre-P1 routing and Trial/Paid change is merged (`aff7979`,
PR #36) and audited (`0344735`, PR #37). P1.1 (`9c0e8fc`), P1.2 (`ea6f9f7`), P1.3 (`8e7ab42`) and
P1.4 (`01860fa`, inside editor Slice 5) are merged. P1.5's delivery gate is merged (`1d4b8e3`);
its renderer half is not. The editor delta plan, `docs/EDITOR_DELTA_PLAN_2026-08-18.md`, is
complete and closed — Slices 1–13, PRs #43 through #72. `main` is at `bd934ca` and production
runs it.

**Next: the P1.5 renderer remainder, then P1.6.** Then P1.7–P1.12, P2, P3, P4, P5 and P6, in this
document's order. The product owner chose that order on 2026-09-05 (`DECISIONS.md`, "Build The
Whole Plan In Order; No Customer Until Publishing Works").

**The record of actual progress and deviations is `docs/AGENTIC_EDITOR_PROGRESS.md`.** Read it
before continuing; it lists the deliberate departures from this plan's text. Where a commit below
carries a **Built** or **Status** note, that note is more recent than the commit's bullets and
wins.

This document was written on 2026-08-11 against branch `feat/reel-builder-trim` at `004db2f`. The
file and line citations in the commit bullets refer to that tree, and several are stale. A module
named here is a claim; the tree is the evidence. Read it before acting on a citation.

---

## 0. What changed from the draft plan and final review

The draft's architecture, phase structure, and economics survive intact. This revision includes Claude's verification pass plus the final corrections that Jake accepted after Codex reviewed the plan. Summary:

**Corrections from the final Codex review, accepted by Jake:**

- **P0.0 is now a policy commit, not a visibility change.** Codex's objection was correct — the repository is public and the draft would have committed the acquisition strategy and margin model into permanent public history. Jake's resolution (2026-08-11) is different from going private today: **stay public through P0–P4, go private at the start of P5**, and simply never commit the sensitive documents while public. This keeps free branch protection and unlimited Actions minutes through the heaviest CI phase, costs nothing, and still guarantees the moat is never published — because the proprietary editorial policy is first written in P5. `CTO.md` and the margin/scale projections are excluded from the repository outright (§5.0), since public history cannot be retracted later.
- Keep the global publishing switch default-off from P0.16 through P1. Enable it only after one exact human-approved P2 sandbox clip publishes successfully.
- Add `ServiceSlot.UNMATCHED` to Wave 1 and use that one name throughout.
- Define the schedule constraint exactly as one non-`MISSED` row per workspace and date.
- Make P0.9 behavior exact: development without a key uses a labeled heuristic; production fails unless a visible, logged override is active.
- Move the complete atomic `REPLACE` operation into P2. P3 no longer gates the start of the human-reference period.
- Require 30 complete days for blind shadow and 30 complete days for agent-first-held review, in addition to the evidence-count gates.
- Keep internal candidate limits absent from every church-facing response and screen.
- Recheck every forbidden category during final-render review and remove graphics from the agent's allowed revision operations.
- Freeze candidate settings at project creation.
- Give P3 a complete commit sequence. Keep P4–P8 evidence-based until P0 measurements justify exact commit boundaries.

**Blockers fixed:**

1. **Silent heuristic analysis fallback (Addendum S4 violation, live today).** `src/lib/analysis/index.ts:6-12` silently selects a $0 lexicon provider whenever `ANTHROPIC_API_KEY` is missing — in any environment, with no event. No draft commit fixed it; the entire 30-day human-review corpus was one expired key away from being heuristic output labeled as Claude output. New commit **P0.9**.
2. **No `ScheduledPost → ExportJob` binding in any migration wave.** Consumers P1.11, P1.12, P2.4, P2.7, P2.8, and P3 need "the exact export for this slot," but `ScheduledPost` has no export reference and no wave added one — every consumer would re-derive "latest matching export" at query time, recreating the publisher defect in subtler form. Added to **Wave 1 (P0.17)**.

**Important new or expanded commits:**

- **P0.0** — record the public-repository policy, the P5 go-private trigger, and the never-commit-while-public document list.
- **P0.1** — working-tree and decision-log hygiene; commit the Tier-3 log with the 2026-08-11 production audit that closes the cleanup hold, plus catch-up decisions. `CTO.md` is deliberately *not* committed.
- **P0.9** — block silent heuristic analysis in production.
- **P0.16** — global publisher kill switch (required *before* the Wave 1 deploy runbook can say "disable automatic publishing" — today the only publishing gates are per-workspace `autoPostEnabled` and unsetting `META_SYSTEM_USER_TOKEN`, both invisible to the repository).
- **P2.7** — make `REPLACE`, reserve selection, supersession, exact rebinding, and priority render enqueue one transaction.
- **P2.9** — start the human-reference clock after Gate C and the controlled P2 sandbox proof, with no P3 dependency.

**Moved / re-scoped:**

- `EditorialException` moves from Wave 2 to **Wave 1** (P1.9 UNFILLED notifications and P1.12 indeterminate publish outcomes need it a wave early; it has no ClipReview dependency).
- The `deriveServiceSlot` PRIMARY-misfile fix is folded into **P1.8** and the service-occurrence snapshot into **P0.7**; without them, P1.9's `UNMATCHED` reserve-only rule (S10) is inert because every project reads PRIMARY today.
- **P1.9** now carries a retention-activation safeguard: setting `Project.expiresAt` turns on a source-purge path that has *never executed in production* (nothing sets `expiresAt` today), so deletion ships in report-only mode first.
- **P1.12** now explicitly deletes the publisher's latest-SUCCEEDED-export lookup (`src/lib/integrations/facebook-publisher.ts:199-205`) — the single most important consumer change, previously in no commit's stated outcome.
- **P0.15** (was P0.13) is a combined preflight: schedule-date collisions *plus* a historical-export census.
- **P0.18** (was P0.15) also fixes the worker tick loop's single try/catch (one throwing periodic block currently starves all later blocks in the same tick).
- The customer-approval relocation (export-gate → publish-gate) **has landed early and out of order** (2026-08-18 decision). The route-level export gate is removed; approval now guards publishing and scheduling only. P1.11 no longer has to retain or reason about an export gate — see the status revision on P1.11.
- The Addendum S2 free-egress storage check moves from P4 into **Gate A / P0.19**.
- P3 is now a complete nine-commit candidate/operator experience phase. The former P3 reserve transaction and priority claim work moved to P2.7.

**Premise corrections carried throughout:** post-`c1603cd` analyzer reality (two-stage Haiku/Sonnet flow with window sampling and IoU thinning — the "hundreds of repeated windows to the scoring model" defect is partially already fixed); the filler default-delete lives in `src/lib/editor/types.ts:80-85`, not `words.ts`; the export idempotency defect is worse than the draft stated (the UI never sends a filename, and the server default stamps *today's date*, so the key silently rotates at midnight for the same clip and version); measured cost anchors from the 2026-07-24 sandbox run are added to the economics. A full renumbering map is in Appendix B.

---

## 1. Executive decision

Build the new editor in controlled phases. Do not replace the current product in one change.

### Problem statement

The current pipeline can find transcript passages and render clips, but it cannot yet prove that each selected moment is visually usable, free of forbidden service content, tied to the exact reviewed edit, or good enough to publish without a human. It also has no complete per-service cost truth. Adding an autonomous agent on top of these gaps would create unsafe delivery and poor training data.

Live evidence sharpens this: the 2026-07-24 sandbox run proved end-to-end proxy import, export, and a real Facebook publish — and also showed a 50-minute sermon producing only 2 candidate clips for $0.19 of analysis spend, plus a publisher that selects "the latest successful export" rather than the export that was reviewed.

### Solution

Keep the existing processing and rendering boundaries. Add exact provenance, continuous-source enforcement, a low-cost derivative and media-region layer, a transcript-first Selector, exact-render QC, and an evidence-gated Review Agent. Use Jake's append-only review data to improve one general editing policy.

The first working release must make the current system safe and measurable. It must then collect good human review data. Only after that work should Pulpit Engine add the new visual index, Selector, and Review Agent.

The editing-agent calls are not the main cost risk. Source-video intake through a residential YouTube proxy is the main cost risk. Target unit economics are held in the private planning copy; the cost gates in §5.5 are the values this repository enforces.

The build order is:

1. **P0:** Freeze policy, create evaluation data, add cost truth, and fix current unsafe defaults (including the silent heuristic fallback).
2. **P1:** Fix export, scheduling, continuity, reanalysis, and publishing correctness.
3. **P2:** Build Jake's exact-render review system, atomic reserve replacement, and the fixed 30-day human-only phase.
4. **P3:** Finish the church and operator candidate-pool experience. P3 is not a prerequisite for the human-only clock.
5. **P4:** Build derivative-first sermon understanding and the Media Region Index.
6. **P5:** Add the agentic Selector in shadow mode.
7. **P6:** Add deterministic final-render QC and the Review Agent.
8. **P7:** Run the fixed 30/30/30 operating program. Use evidence gates for autonomy.
9. **P8:** Improve one general editing policy from trusted review data.

Do not fine-tune a model first. Rules, structured evidence, deterministic checks, and good review labels have a better cost-to-quality ratio.

---

## 2. Product rules that this plan treats as final

### 2.1 Editorial rule

> Pulpit Engine selects what the pastor said. It does not rewrite what the pastor said through editing.

Every delivered clip uses one continuous source range. This rule applies to automatic clips and clips that Jake revises.

Allowed edits: start time, end time, crop or reframe, captions, title, hook.

Forbidden edits: internal word deletion, internal filler deletion, internal pause deletion, internal repeated-phrase deletion, any other middle cut.

The Selector and Reviewer must prefer a naturally strong delivery. They must not select weak speech and try to repair it with many edits. (Product-owner Decision 3; Addendum S18-iii records that automatic clips keeping every "um" is an accepted product consequence — correctness over polish.)

The drag-to-trim timeline shipped in `004db2f` (`src/components/editor/clip-timeline.tsx`, `src/lib/editor/trim.ts`) writes only `state.source.startMs/endMs` — it is exactly the allowed boundary-edit surface, and P1 builds on it rather than replacing it.

### 2.2 Candidate rule

- The master default is 18 candidates per service.
- The master hard maximum is 18 at first.
- The system can return fewer than 18. The system must not add weak clips to reach 18.
- A hidden church override can lower or change the effective limit within the master maximum.
- Only Pulpit Engine staff can change the hidden override. Church users must not see or change it. (Product-owner Decision 1, overriding the Addendum's Decision-A deferral.)
- Resolve and copy the effective value into project configuration when the project is created. Later master or church-setting changes do not change that project.
- No church-facing API response, page, label, or count promise exposes the configured ceiling or the hidden override. Church users see only the candidates that actually exist.

The ranked candidate list is one queue. It does not contain a separate backup for each primary clip.

Note: no customer-facing surface promises "18" today — the only public count promise is 6 clips/week in `docs/BUSINESS_OVERVIEW.md:31`. P3 must not introduce an "up to N" ceiling label. Church users see the actual available clips; only platform staff can inspect internal limit facts.

### 2.3 Weekly posting rule

- One service per week: schedule ranks 1–6 from that service.
- Two services per week: schedule ranks 1–3 from each service.
- Three services per week: show the option as disabled with "Coming later." (New UI work — today's onboarding/settings dropdowns offer exactly two options, enforced in three layers: the `<option>` lists, the Zod `.min(1).max(2)`, and the `SermonsPerWeek = 1 | 2` type.)
- Sunday is always off. (Note: current production behavior can violate this — scheduling is pure `sermonDate + rank` day arithmetic with no weekday awareness, `src/lib/scheduling.ts:8-12` — fixed in P1.8/P1.9.)
- The configured service days control the allocation (`ChurchProfile.serviceDay` / `secondServiceDay` already exist in workspace settings). Do not hard-code Sunday and Wednesday — they are only UI defaults today.
- A special service is analyzed but is not scheduled automatically.
- A missed date is marked `MISSED`. Later posts do not shift.

### 2.4 Review decisions

The only decisions are `ACCEPT`, `REVISE`, `REPLACE`. A review can contain zero, one, or many feedback items. Jake can add more feedback later.

### 2.5 Review transition

- Days 1–30: Jake reviews every scheduled final render. The agent does not influence the decision. **Fixed full 30 days** (Product-owner Decision 2, superseding Addendum S17's compression permission).
- Days 31–60: Run at least 30 complete calendar days of blind shadow. Jake and the agent review independently. Jake commits first. The agent result stays hidden until then. Evidence shortages extend this phase.
- Days 61–90: Run at least 30 complete calendar days of agent-first-held review. The agent works first. Every delivery remains held for Jake's audit. Evidence shortages extend this phase.
- After day 90: Autonomy is permitted only after all evidence gates pass and Jake explicitly promotes the policy.
- Long term: The agent handles routine reviews. Humans handle exceptions and blind random audits.

The 90 days are a minimum. A small pilot can take longer to collect enough decisions.

### 2.6 Media rule

> Never move, analyze, render, or store the full source video when a smaller derivative will do the job.

Target media flow:

```text
one source acquisition
→ temporary original
→ compressed mono audio
→ enriched transcript
→ one uncropped 480p source proxy
→ sparse frames, waveform, hashes, and media regions
→ ranked continuous edit plans
→ verified high-quality source ranges for retained candidates
→ final render only for scheduled or promoted clips
→ QC evidence from that exact final render
```

The first safe release can retain the original until the range-derivative path is proven. The target is to create verified, keyframe-padded, original-quality range derivatives for all retained candidates, then delete the large original early. Use configurable handles around each range. Merge overlapping ranges. The final render performs the exact frame cut.

Do not make 18 final vertical MP4 files for every service. Reserve candidates use the shared proxy for review. They receive a final MP4 only after promotion.

---

## 3. Current architecture and reuse decision

### 3.1 Current flow (verified 2026-08-10, post-`c1603cd`)

```text
upload or URL import (yt-dlp, optional YTDLP_PROXY_URL residential proxy)
→ FINALIZE (plan/minute gates live here)
→ PROBE creates source facts, poster, and WAV
→ TRANSCRIBE with local whisper.cpp (ggml-base.en, per-token confidence)
→ ANALYZE builds up to 500 candidate windows
   (≤3 duration targets per start position, evenly sampled across the
    whole transcript when the pool exceeds 500 — c1603cd)
→ Stage A: one Claude Haiku classification call over the window set
→ IoU > 0.5 thinning of Stage A survivors
→ Stage B: one Claude Sonnet scoring call over ≤25 candidates
→ keep up to 18 generated clips (CANDIDATE_POOL_SIZE, analyze.ts:15)
→ arm the first targetClipCount calendar rows (6, or 3 for two-service
   churches) via sermonDate + rank arithmetic
→ manual edit and customer approval tools
→ FFmpeg export (multi-pass; internal word cuts → segment concat)
→ Facebook publishing worker (publishes latest SUCCEEDED export)
```

Both analysis calls are realtime streaming calls (Haiku Stage A, Sonnet Stage B) — the Batch API is not used today. If `ANTHROPIC_API_KEY` is missing, provider selection silently falls back to a $0 heuristic lexicon scorer in any environment (fixed in P0.9).

### 3.2 Components that remain

- Prisma and PostgreSQL
- The existing processing-job queue and reliability pattern
- The separate export queue
- The storage-provider interface (single `getStorageProvider()` factory; four `downloadToFile` materialization call sites)
- R2-compatible object storage
- FFmpeg and FFprobe
- Existing crop, caption, brand-template, and export modules
- Existing workspace settings and project `processingConfig`
- Existing customer `ClipApproval`
- Existing calendar and `ScheduledPost`
- Existing Facebook connection and publisher
- Existing operational-event and alert systems
- Existing worker service
- Existing timezone helpers (in `src/lib/church-profile.ts`; no external tz library)
- The current `ANALYZE` job seam
- The drag-to-trim timeline and `src/lib/editor/trim.ts` boundary math

These pieces need focused corrections. They do not need a rewrite.

### 3.3 Components that change

- Export jobs must pin an exact edit version (`ExportJob` has no version column today; render loads the latest edit at run time, `src/lib/exports/handler.ts:70-76`).
- New deliverable edits must be continuous (today internal word deletions produce multi-segment concat renders, `src/lib/export/kept-ranges.ts` + `render.ts`).
- Reanalysis must not delete review, export, or publication history (today `analyze.ts:132` deletes all generated clips).
- Scheduling must use configured weekdays and explicit slot states (today: `sermonDate + rank`, Sunday included, `deriveServiceSlot` misfiles unmatched services as PRIMARY, and `Project.serviceSlot` is written but never read).
- Publishing must use one fail-closed Delivery Eligibility Module bound to the slot's exact export (today: latest SUCCEEDED export, `facebook-publisher.ts:199-205`; customer approval gates *export*, not publish, and editing demotes approval while the old export stays publishable).
- The transcript must support speakers, pauses, audio events, sentence boundaries, paragraph boundaries, capabilities, and provenance.
- Visual facts must be stored as source-level media regions.
- Candidate generation must keep improving token economics (Stage A input still scales with the sampled window count; Stage B is already capped at 25 post-thinning).
- Final renders must receive deterministic and subjective review.
- All paid and local stages must report cost — including which provider/model actually ran, so heuristic output can never masquerade as Claude output.

---

## 4. Recommended low-cost component choices

| Need | First choice | Why | Escalation |
|---|---|---|---|
| Detailed ASR | ElevenLabs Scribe v2 after benchmark | $0.22/audio hour includes word times, speaker diarization, and audio tags. Removes several local integration steps. | Keep whisper.cpp as benchmark/fallback. Test self-hosted faster-whisper only when ASR spend reaches ~$500–$1,000/month. |
| Pauses | Word-gap rules plus FFmpeg silence detection | Deterministic and effectively free. | None unless the transcript is unreliable. |
| Sentence/paragraph boundaries | Punctuation, word gaps, deterministic grouping | Cheap and stable. | A small text-model pass only for ambiguous boundaries. |
| Scene changes | FFmpeg scene score | No paid API. | Adjust thresholds from the labeled corpus. |
| Static slides | Perceptual hash, frame similarity, edge/text density | Cheap on sparse frames. | OCR and person detection on cluster representatives. |
| Slide text | Tesseract OCR or another Apache-licensed local OCR | No per-call fee. Run only on likely slides. | One Claude vision escalation for unresolved regions. |
| Pastor visibility | A small, commercially safe ONNX person/face detector | CPU inference on sparse representative frames. | Claude vision only for ambiguity. |
| Worship and audio events | ASR audio tags, signal features, small local classifier | Avoid continuous multimodal analysis. | Transcript classification, then one visual escalation. |
| Candidate ranking | Deterministic filtering, short phrase blocks, then one batched strong-model ranking call | Preserves quality and controls tokens. | Standard-priority call only for an urgent replacement. |
| Final Review Agent | Deterministic QC plus a compact contact sheet, boundary strips, transcript, and metadata | Reviews the exact output without sending the full service. | Human exception. |
| Storage | Cloudflare R2-class free-egress object storage | Existing S3-compatible provider can use it (`STORAGE_S3_ENDPOINT`). | Do not use an egress-billed bucket without a measured reason. |
| Rendering | Existing FFmpeg worker | Deterministic, cheap, already integrated. | Add source caching and per-project batch materialization. |

Do not add a second LLM vendor during the MVP. Add one only if shadow data shows correlated safety errors from the Claude model family.

---

## 5. Economics

### 5.0 What this repository copy publishes

This is the sanitized copy of the implementation plan. It publishes everything the build needs:
the usage profiles, the per-stage technical costs, the intake comparison, the code-enforced cost
gates, the measured production anchors, the provider price sources, and the full P0–P4 commit
sequence.

It withholds business-strategic material that contributes nothing to building the software:
revenue and gross-margin projections, the scale model, price positioning, and the P5/P6 editorial
policy design. Those live with the private planning copy in the operator's workspace and are added
here once the repository is private at the start of P5.

Withheld sections are marked in place rather than silently deleted, so a reader always knows what
exists and where it lives.

### 5.1 Usage profiles

The model uses 52 weeks divided by 12 months, or 4.33 weeks per month.

| Profile | Services each week | Duration assumption | Monthly source minutes | Candidate capacity each month | Scheduled clips each month |
|---|---:|---|---:|---:|---:|
| Light | 1 | Sunday 75–90 minutes | 325–390; midpoint **358** | Up to 78 | About 26 |
| Typical | 2 | Sunday 75–90 plus one 45–75 minute service | 520–715; midpoint **618** | Up to 156 | About 26 |
| Heavy | 3 | Sunday 75–90 plus two 45–75 minute services | 715–1,040; midpoint **878** | Up to 234 | About 26 |

The heavy case assumes that the third service has the same range as the normal midweek service.

The render model allows about 15 percent revisions or replacements — about 30 final render attempts per month. Reserve candidates do not receive final MP4 files until promotion.

### 5.2 Direct-upload variable cost model

These values use standard provider prices. They do not depend on trial credits or the temporary Sonnet 5 promotion.

| Cost item | Light | Typical | Heavy |
|---|---:|---:|---:|
| Temporary source and derivative storage | $0.11 | $0.16 | $0.23 |
| Audio extraction and preprocessing | $0.04 | $0.06 | $0.09 |
| Scribe v2 transcription | $1.31 | $2.26 | $3.22 |
| Local visual/audio index and forbidden detection | $0.15 | $0.26 | $0.37 |
| Paid sermon/forbidden classification | $0.09 | $0.17 | $0.26 |
| Candidate selection and ranking | $0.26 | $0.52 | $0.78 |
| Review Agent | $0.35 | $0.35 | $0.35 |
| Final FFmpeg rendering | $0.15 | $0.15 | $0.15 |
| Caption generation | $0.00 | $0.00 | $0.00 |
| Social API use | $0.00 | $0.00 | $0.00 |
| Twelve-month rolling final-clip storage | $0.24 | $0.24 | $0.24 |
| Worker-to-storage egress | $0.08 | $0.10 | $0.12 |
| Database, email, and monitoring variable allocation | $0.05 | $0.07 | $0.09 |
| Ten-percent retry reserve | $0.24 | $0.38 | $0.52 |
| Stripe Payments and Billing | $2.10 | $2.10 | $2.10 |
| **Direct browser-upload total** | **$5.17** | **$6.82** | **$8.52** |

This table excludes shared platform minimums, human review labor, support, tax, refunds, marketing, and development payroll.

The repository policy adds no GitHub subscription cost during P0–P4. At the start of P5, the current decision adds approximately $4/month of fixed GitHub Pro overhead so the now-private repository can retain protected branches. That future fixed platform cost is not a P0–P4 processing cost and is excluded from the variable technical totals above. Recheck GitHub pricing when the P5 trigger fires.

The direct technical cost, before Stripe, is about: Light $3.07/month (~$0.71/service); Typical $4.72/month (~$0.55/service); Heavy $6.42/month (~$0.49/service). The per-service number falls as service count rises because routine delivery remains six clips per week.

### 5.2.1 Calls and cost for one typical service

| Stage | Normal calls or jobs per service | Typical direct-path cost per service | Cheaper control |
|---|---:|---:|---|
| Source acquisition | 1 | $0 direct; ~$0.26 PERC; ~$1.26 under the current proxy estimate | Direct upload or proven PERC |
| Derivative build and temporary storage | 1 local batch | $0.02 | One source materialization; merge range derivatives |
| Audio preprocessing | 1 local batch | $0.01 | FFmpeg |
| Scribe transcription | 1 API call | $0.26 | Benchmark self-hosting later, not during the small pilot |
| Local forbidden/media index | 1 local batch | $0.03 | Sparse/scene-triggered frames only |
| Transcript sermon/forbidden classification | 1 compact call | $0.02 | Batch API and structured output |
| Ambiguous visual escalation | 0 normally; maximum 1 | Included in the $0.02 planning reserve | Exception after one attempt |
| Candidate selection | 2 batched calls: cheap extraction plus strong ranking | $0.06 | Filter and pack locally first |
| Review Agent | 1 batch for the service's scheduled finals | $0.04 | Contact sheets and metadata, not full video |
| Final rendering | Normally 3 finals for a two-service church's service, plus revision reserve | $0.02 | Render scheduled/promoted clips only |
| Captions | 0 paid calls | $0.00 | Existing transcript and FFmpeg/libass |
| Social publishing | 1 API call per scheduled clip | $0.00 direct API fee | Existing worker and exact intent |
| Final storage and service egress | Object operations per final | ~$0.04 | R2-class free egress and compact final files |
| Database, monitoring, and retry reserve | Several local writes | ~$0.05 | Daily rollup, idempotency, bounded retry |
| **Typical direct technical total** | — | **About $0.55/service** | Hard cap remains $1.50 excluding intake/payment |

For a typical church, the planned monthly volume is about: 8.66 source acquisitions; 8.66 transcription calls; 8.66 transcript classification calls; no more than 8.66 paid visual escalations (normal use much lower); 17.32 Selector calls before further batching; 8.66 Review Agent batches; ~30 final render attempts; ~26 publishing calls per enabled platform.

### 5.3 Intake sensitivity

| Intake path | Light monthly cost | Typical monthly cost | Heavy monthly cost |
|---|---:|---:|---:|
| Direct browser-to-object-storage upload | $5.17 | $6.82 | $8.52 |
| Current server-relayed upload | $5.62 | $7.59 | $9.62 |
| Cloudflare Stream / PERC | $6.62 | $9.04 | $11.67 |
| Current internal YouTube-proxy estimate | $11.51 | $17.77 | $24.08 |

The current repository estimate is about $10 in proxy bandwidth for a typical church. It is not proven — no byte metering exists in the yt-dlp path today. A public retail proxy price can make the proxy alone exceed the entire per-church cost budget. Therefore, P0 must measure real bytes and the real contracted price before the YouTube path is accepted.

Recommended intake strategy:

1. Use direct browser upload when the church can upload.
2. Use YouTube proxy import as an easy acquisition and fallback path.
3. Prove PERC and move stable churches to it when operationally reliable. (PERC has zero implementation today — it exists only as the ADR at `DECISIONS.md:1069`; its automated MP4 retrieval has never worked end-to-end.)
4. Do not make a high-cost retail residential proxy the permanent default.

### 5.4 Scale model — WITHHELD

Revenue and gross-margin projections at scale are not published in this repository copy. They
live with the private planning copy. The engineering conclusion they support is public and
unchanged: **optimize source intake before optimizing agent calls.** The new forbidden-content,
Selector, and Review Agent work adds roughly $1.04 per typical church per month, while the
unproven YouTube proxy path adds roughly $10.18 before related service egress.

### 5.5 Cost gates

- Core technical cost per service, excluding intake and payment: hard cap of **$1.50**.
- Typical direct-upload variable COGS: target **$8 or less per month**.
- Typical stable PERC variable COGS: target **$10 or less per month**.
- Typical YouTube intake: must prove **$12 or less per month** or it cannot be the long-term standard path.
- A paid stage with no known unit price blocks the P0 cost gate.
- Budget exhaustion finishes deterministic work and creates an exception. Production must not silently switch to the heuristic selector — and P0.9 closes the *existing* silent-heuristic path, not just the future one.

### 5.6 Measured calibration anchors (two production runs)

Real numbers exist for the same 49:41 source video (`z4FCS3JcZPs`), measured twice, and must anchor Gate A's plausibility checks. Sources: `docs/TIER3_SANDBOX_TEST_CHECKLIST.md` and the four catch-up entries, both committed in P0.1.

**Run 1 — 2026-07-24, pre-`c1603cd`** (workspace `Tier 3 Sandbox Test`, target 3):

- **$0.19 analysis spend**; 112K input / 7.3K output tokens across the Haiku Stage A and Sonnet Stage B realtime calls.
- **2 kept clips**, both starting at minute 0, both announcements rather than sermon content. This is the funnel failure that motivated `c1603cd`.
- One real Facebook publish succeeded end to end (post `999309073105794`, `attempt_count=0`), proving the Tier-3 path the eligibility module will wrap.

**Run 2 — 2026-08-11, post-`c1603cd`** (workspace `Jake's Church`, target 6, project `Clip Count Retest 8-11`):

- **$0.157 analysis spend**; 74,662 input / 9,348 output tokens. Analysis cost fell while output quality rose.
- **6 kept clips**, meeting `targetClipCount` exactly. Part of the count increase is configuration (target 3 → 6); the content change is not.
- **All six are sermon content** — Philippians paradoxes, Paul rejoicing in chains, the creator-creature distinction, a critique of Mormon theology. Zero announcements.
- Full pipeline FINALIZE → ANALYZE in **about 6 minutes** for a 50-minute source. Transcript confirmed complete: 978 segments ending at 49:41 against a 49:41 source, ruling out silent truncation.
- **Open issue, and the P5 baseline:** all six clips fall between 1:25 and 10:58 of 50 minutes. Metadata shows 500 candidate windows in and `scoredCount` 6, so **Stage A classification is the binding constraint**, not window generation and not Stage B ranking. Roughly 39 minutes of sermon never reaches scoring.

**Planning consequences.** The per-service analysis figures in §5.2.1 are conservative against Run 2. Gate A must reconcile against Run 2, not Run 1. P5's objective is measured against Run 2's coverage: the Selector must recover material Stage A currently discards, and "clips confined to the first 20% of the service" is the number to beat.

### 5.7 Price sources

- [ElevenLabs Scribe v2 pricing](https://elevenlabs.io/pricing/api?price.section=speech_to_text): $0.22 per audio hour.
- [ElevenLabs transcription capabilities](https://elevenlabs.io/docs/overview/capabilities/speech-to-text): word times, diarization, audio-event tags.
- [Anthropic pricing](https://docs.anthropic.com/en/docs/about-claude/pricing): standard model prices and a 50-percent Batch API discount.
- [Anthropic Sonnet 5](https://www.anthropic.com/claude/sonnet): standard $3 input and $15 output per million tokens after 2026-08-31.
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/): $0.015 per GB-month and free direct egress.
- [Cloudflare Stream pricing](https://developers.cloudflare.com/stream/pricing/): $5 per 1,000 stored minutes and $1 per 1,000 delivered minutes.
- [Railway pricing](https://docs.railway.com/pricing): CPU, memory, and service egress.
- [Stripe pricing](https://stripe.com/pricing) and [Stripe Billing pricing](https://stripe.com/billing/pricing): the per-transaction and billing fee structure used in the cost model.
- [Decodo residential proxy pricing](https://decodo.com/proxies/residential-proxies/pricing): evidence that retail proxy rates can make YouTube ingestion nonviable.

Note for P0.20: plan *prices* live in Stripe, resolved through `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` env vars — `src/lib/billing/plans.ts` contains limits only, no dollar amounts. Plan price positioning is held in the private planning copy.

---

## 6. Pilot-volume warning

One church produces about 26 scheduled decisions per month.

With one church:

- 150 blind shadow comparisons require about 5.8 months of shadow data.
- 300 audited agent-first decisions require about 11.5 months of agent-first data.

These periods are sequential. One church cannot reach both evidence gates in 90 days. Jake currently has one committed church; pilot growth is opportunistic.

Do not reduce the gates to fit the calendar. Add churches when possible and extend the held-review phases honestly.

---

## 7. Standing engineering rules

Every commit in P0–P2 must follow these rules:

- **The repository is public until the start of P5 (P0.0).** Never commit `CTO.md`, gross margins, scale/revenue projections, or price positioning while it is public — public git history cannot be retracted. Everything else, including the technical architecture, `DECISIONS.md`, cost gates, and per-stage costs, commits normally. If a new document is business-strategic rather than build-necessary, it belongs in the Dropbox workspace until the trigger fires.
- `npm run verify` passes (prisma validate/generate + lint + typecheck + unit vitest + build; database- and credential-free by construction).
- Database tests go in `tests/integration/*.integration.test.ts` (own vitest config, needs live Postgres). Browser tests go in `tests/e2e/` (Playwright; boots with `WHISPER_MODEL_PATH=""` — e2e cannot depend on real transcription; seventeen specs as of 2026-09-05, run against a built application on CI since PR #50).
- CI runs four jobs: verify, integration (Postgres 17 container + ffmpeg), e2e, and worker-image (docker build of `Dockerfile.worker` on every PR — new native deps get exercised there). Note the worker image pulls yt-dlp unpinned and clones whisper.cpp at build time, so that job has a live network dependency.
- Commits pass through `.githooks/pre-commit` running gitleaks — fixture tokens/keys need `.gitleaks.toml` allowlist entries, not `--no-verify`.
- Before each UI commit, read the relevant Next 16 guide under `node_modules/next/dist/docs/` (452 files as of Next 16.3.4; this repo's Next differs from training-data conventions).
- `DECISIONS.md` stays append-only. A reversed decision gets a new dated entry and an updated Status on the old entry. Known reversals this plan makes: export idempotency scoped to (clip, edit version, filename) (`DECISIONS.md:599`), rank-date scheduling, the filler-removal default, approval-gates-export.
- Do not rename internal `sermon-clipper` identifiers (`DECISIONS.md:872`).
- Worker-reachable code stays in `src/lib` or `src/worker` (`tsconfig.worker.json` includes only those trees). It must not import Next application modules.
- New job types require an enum value, handler, and `jobHandlers` registration (`src/lib/jobs/handlers/index.ts` — the single registration point; runner and worker derive supported types from it). **`PREVIEW_RENDER` is load-bearing as a deliberately-handlerless type** in `tests/integration/job-reliability.integration.test.ts` — do not repurpose it. **`GENERATE_CLIPS` is a completely unused enum value** — the free slot if a spare type is needed.
- New periodic worker tasks are interval blocks in `src/worker/run-jobs.ts` following the `lastXAt` pattern — **and each block must catch its own errors** (P0.18 introduces per-block isolation; today one try/catch wraps the whole tick and a throwing block starves everything after it).
- New native runtime dependencies go in `dependencies` (the prod-deps Docker stage runs `--omit=dev`). Model files go on `/models` with SHA-256 verification via `scripts/worker-entrypoint.sh`. Worker binary/model checks extend `assertWorkerRuntimeReady` in `src/lib/worker/reliability.ts` (not `readiness.ts` — that file owns web/env readiness).
- New environment fields register in **three places**: `src/lib/env.ts` `fieldSchemas` (lazy parse, no memoization, every field optional/defaulted), `.env.example`, and — if required in production — `src/lib/deployment/readiness.ts` (`checkDeploymentEnvironment`).
- Every production safety switch also has an authoritative entry in `docs/DEPLOYMENT.md`: owning service, safe default, enable and disable procedure, readiness behavior, verification command, and rollback. A switch is not complete when only `.env.example` names it.
- Workspace setting writes use `updateWorkspaceSettings()` (optimistic concurrency, 3 attempts). Reads follow `parseChurchProfile`'s parse-with-defaults, never-throw pattern.
- Project configuration is snapshotted through the single `processingConfig` write point — `buildDraftProjectRecord` in `src/lib/project-service.ts`, reached by both create paths (URL/channel import via `createDraftProjectForWorkspace`, upload via `createProjectFromUploadedSourceVideo`) — and read back defensively like `readTargetClipCount`.
- Expected job failures (`JobFailureError`) create operational events, not Sentry noise. Operational facts go through `recordOperationalEventSafely` (fire-and-forget, transaction-aware). Know that the alert throttle is an in-process Map — it resets on deploy and double-fires across web+worker.
- Cost facts use the P0.10 cost-event contract on OperationalEvent. Do not use `UsageLedger` for COGS (and note its field is `minutesDelta`; `minutesCharged` lives on `ExportJob`).
- Schema changes are additive first. Roll back application code without deleting new data.
- Migrations run from the web deploy (`railway.json` `preDeployCommand: npm run db:migrate:deploy`) before the independent worker deploy (`railway.worker.json`, `Dockerfile.worker`).
- Module naming: pure math in `src/lib/export/`-style DB-free modules; orchestration in `src/lib/exports/`-style DB-coupled modules; new modules get unambiguous names (`src/lib/review`, `src/lib/qc`, `src/lib/schedule`, `src/lib/delivery`, `src/lib/cost`, `src/lib/operations`). Verified 2026-09-05: `src/lib/cost` (P0.10–P0.12), `src/lib/operations` (P0.6, `candidate-limit-override.ts`), `src/lib/delivery` (P0.17, `identity-contract.ts` only), `src/lib/qc` (P1.3, `render-output.ts`) and `src/lib/billing` exist; `src/lib/review` and `src/lib/schedule` do not. P1.8 creates `schedule`; P1.11 fills `delivery`; P2.3 creates `review`. Never create a third near-duplicate sibling.
- Timezone/date math builds on the existing helpers in `src/lib/church-profile.ts` (`calendarDateInTimezone`, `wallClockInstantInTimezone` are exported; `weekdayNameInTimezone` is currently module-private and must be exported when the Posting Schedule Module needs it). No new timezone library.

For every Prisma migration:

1. Run `npx prisma migrate dev --create-only`.
2. Inspect the SQL.
3. Remove `DROP INDEX "transcripts_search_vector_idx"` if Prisma adds it.
4. Remove `ALTER TABLE "transcripts" ALTER COLUMN "search_vector" DROP DEFAULT` if Prisma adds it.
   (Left in, deploy fails with `42601` — `DECISIONS.md:481-489`, status Active. This is not automatable; budget it into every migration commit.)
5. Test a clean database and an upgrade database.

Use at most three migration waves:

- **Wave 1 (P0.17):** P1 correctness fields, `ServiceSlot.UNMATCHED`, P0 rollup support, the ScheduledPost→ExportJob binding, and `EditorialException`.
- **Wave 2 (P2.1):** review, feedback, operator, and program state.
- **Wave 3 (P4):** media regions and derived artifacts.

---

## 8. Checkpoints

### Gate A — Cost truth

One real service must produce a complete report with source minutes, bytes, proxy bytes, storage, CPU time, transcription seconds, all model tokens/images, **the provider/model that actually ran each paid stage**, render minutes, retries, output bytes, stage cost, service cost, and projected monthly church cost. The report must also record the production storage provider (the `STORAGE_S3_ENDPOINT` host) and its contracted egress price, settling the Addendum S2 free-egress question with P0 data instead of discovering it at P4.

Plausibility anchor: the report's analysis-stage numbers should be reconcilable with the measured 2026-07-24 baseline (§5.6).

### Gate B — Correctness

No code can publish a clip unless one module proves that the exact current export, edit version, checksum, review, optional customer approval, slot, and pilot state are eligible — resolved through the slot's bound `exportJobId`, never through a "latest export" query.

### Gate C — Human-review readiness

Jake must be able to play the exact final render, record `ACCEPT`, `REVISE`, or `REPLACE`, add multiple feedback items, and prove that a later edit invalidates the old acceptance.

The fixed 30-day clock starts only after Gate C passes, including a successful atomic P2 `REPLACE` smoke test. P3 does not gate the clock.


---

## 9. P0 — Evaluation, immediate controls, current defects, and cost truth (21 commits, including P0.0)

P0 has no autonomous behavior. It creates the facts and safe defaults that later work needs.

### P0.0 — Record the repository-visibility policy and its migration trigger

**Commit:** `docs(repo): record the public-repository policy and the go-private trigger`

- **Outcome:** The repository **stays public through P0–P4** and goes private **at the start of P5**. This is a deliberate, dated decision with a named trigger, not an omission. One documentation commit; no application behavior changes and no GitHub setting changes today.

  **Why public is correct now.** Public repositories get branch protection free — all four required checks (`verify`, `integration`, `e2e`, `worker-image`) are already active with strict mode and administrator enforcement, verified 2026-08-11 — and **unlimited GitHub Actions minutes**. Private repositories require GitHub Pro or Team at $4/user/month for protected branches (confirmed on the GitHub pricing page 2026-08-11: "Repository rules — Public repositories" on the Free tier, for personal accounts *and* free organizations alike), and cap Actions at 3,000 minutes/month. With branch protection forcing every one of the ~50 planned commits through a pull request, and CI re-running on every push, private CI is a real constraint during exactly the phase that pushes hardest. Going private now would cost money and CI headroom to protect code that is not yet a moat.

  **Why the trigger is the start of P5.** P0–P4 build correctness plumbing — export version pinning, schedule math, delivery eligibility, cost metering, media derivatives. Any competent engineer would write the same thing; none of it is defensible IP. The proprietary asset — the Selector policy, the Review Agent policy, the refined editorial standard, and the prompts that encode them — is first written in **P5**. Going private before P5 means the moat is never public at all.

  **The rule that makes this safe.** Public git history is permanent: making a repository private later does not retract what was already published, because public repositories are continuously indexed by code search, archives, and crawlers, and existing forks survive as independent public repositories. Therefore the deferral covers *visibility only*. Documents that must never be public are never committed while the repository is public, regardless of the trigger:

  - **`CTO.md` — never committed while public.** It is the acquisition strategy and the operating instructions for AI agents, not code documentation. It stays in the Dropbox workspace. `DECISIONS.md:1093` cites it normatively; that citation is amended to name it as an external, private document.
  - **Margin, scale, and pricing projections — not committed while public.** The withheld subsections are marked in place; see §5.0 and §5.4.
  - **P5/P6 editorial logic — not committed while public.** Replace all of §14 (Selector policy) and §15 (Review Agent design) in the P0.2 public copy with pointers to the private plan. The full sections can be added only after the P5 privacy precondition passes.
  - **Cost *gates* are committed** — the $1.50/service cap and the $8/month target — because the code and its tests must honor them.

- **Files:** `docs/DEPLOYMENT.md` (record the policy, the trigger, and the current verified protection state); `DECISIONS.md`.
- **Migration:** None.
- **Decision log:** New entry — *Repository Stays Public Until P5; Strategy, Margin, and Editorial-Policy Documents Are Never Committed While Public*. Status Active. Record the trigger (start of P5), the reasons (free branch protection, unlimited Actions, no moat in P0–P4), the permanence rule (public history cannot be retracted), the excluded-document list including private-plan §§14–15, the bounded fact that one historical price assumption is already present in public history and cannot be retracted, and the cost of reversing (GitHub Pro at $4/month, plus a 3,000-minute Actions cap). Supersede the `docs/DEPLOYMENT.md:503` rationale, which recorded the July public flip as a branch-protection workaround with "revisit if/when proprietary-source exposure becomes a real concern" — this entry is that revisit, and it names the concern's arrival date as P5.
- **Verification:** Confirm current state before writing the entry: `gh repo view Jgandara24/sermon-clipper --json visibility,isPrivate` and `gh api repos/Jgandara24/sermon-clipper/branches/main/protection`. Both were captured on 2026-08-11 — public, with all four contexts required, strict mode on, `enforce_admins` true, force pushes and deletions blocked. Re-verify rather than trusting this record.
- **Rollback:** Documentation-only revert. Going private early is always permitted and never needs a rollback — it is a one-command change (`gh repo edit --visibility private`) plus re-applying the saved protection payload, and it requires an active GitHub Pro subscription first.
- **Trace:** Jake's decision of 2026-08-11; `docs/DEPLOYMENT.md:503` public-repository history; `CTO.md` proprietary-IP and migration-trigger policy.

**P5 precondition (restated in §14):** the first P5 commit must not land until the repository is private with protection re-verified.

### P0.1 — Working-tree and decision-log hygiene

**Commit:** `chore(repo): commit sandbox evidence and catch up the decision log`

- **Outcome:** Start P0 from a clean, honest tree, under the P0.0 public-repository rules. Commit the Tier-3 sandbox test log with Section 9 completed by the 2026-08-11 read-only production audit. Record that auto-posting is off in both workspaces, the sandbox Page ID is retained deliberately, and post `999309073105794` remains as evidence because First Baptist Sandbox is a permanent test asset. The separate historical Meta Business Suite verification box can remain unchecked; it is not a cleanup or merge hold because the provider ID, database state, calendar state, and production audit already establish the bounded result needed by this plan. Record that the service produced two clips, only rank 1 was exported, and rank 2 could not pass the current successful-export gate — so no unattended publish beyond the one intended post was possible. The log proves one real Facebook publish on 2026-07-24 and records the $0.19 / 2-clip analysis baseline. The log is safe to commit publicly: the page is a sandbox page and the post ID is already public. **`CTO.md` is NOT committed** — per P0.0 it stays in the Dropbox workspace while the repository is public; amend the `DECISIONS.md:1093` citation to name it as an external private document rather than a repository file. Append catch-up `DECISIONS.md` entries for the three orphan commits that changed recorded behavior without entries: `a4b0ab6` (Stage A truncation fix), `c1603cd` (full-sermon window coverage — P0.4's charter cites this entry), `004db2f` (drag-to-trim timeline). Correct the proxy ADR's stale proof status; the sandbox log proves one real import, while proxy economics and PERC retrieval remain unproven.
- **Files:** `docs/TIER3_SANDBOX_TEST_CHECKLIST.md`; `DECISIONS.md`.
- **Migration:** None.
- **Tests:** `npm run verify`.
- **Decision log:** Three catch-up entries as above, plus `Residential Proxy Import Is Functionally Proven; Its Economics Remain Gated`. Preserve the facts that $0.19 is analysis cost, not proxy cost; transferred bytes and contracted $/GB remain unmeasured; PERC remains unproven; and derivative-first processing follows one complete source acquisition rather than a second YouTube request.
- **Merge gate: CLEARED 2026-08-11.** Both original hold items are resolved and the checklist's Section 9 now records the evidence. A read-only production audit confirmed auto-posting is `false` in **both** workspaces — `Jake's Church` (no Page ID) and `Tier 3 Sandbox Test` (Page ID `1128280933691493` retained deliberately). The test post is **not** deleted and does not need to be: First Baptist Sandbox is Jake's own permanent test page, maintained for this purpose. The whole database holds exactly two scheduled posts — the 07-24 success, and one NOT_STARTED row from 07-26 that never published because it has no successful export. P0.1 may merge.
- **Standing asset this establishes:** the sandbox Page is a reusable, disposable Graph API target. P1.12 (publish intent and reconciliation) and the P2 go-live proof can exercise real Meta behavior end to end without touching a customer page. Cite it in both.
- **Branch baseline:** This plan intentionally starts from local `feat/reel-builder-trim` at `004db2f`, one commit ahead of `origin/main`. Therefore the P0 pull request must include and review `004db2f`. Do not also merge the different trim implementation from `feat/editor-trim-and-caption-typography` without a separate conflict/product review.
- **Rollback:** Documentation-only revert.
- **Trace:** Repository append-only discipline (§7); P0.4 and §5.6 dependencies.

### P0.2 — Freeze the accepted architecture and editorial standard

**Commit:** `docs(agentic-editor): freeze the accepted product rules`

- **Outcome:** Put the accepted P0–P4 architecture in the repository. Record the three product-owner overrides: build the staff-only candidate override now, keep a full 30 human-only days, and require continuity for Jake's revisions. Include this plan document as an explicitly checked sanitized copy. Apply the complete private §5.0 redaction manifest across the whole document, not only §5.2 and §5.4. Replace withheld price/margin material, all of §14, and all of §15 with short pointers to the private planning copy. Do not commit the exact-value redaction manifest itself. The P0–P4 technical architecture, editorial standard, technical unit costs, cost gates, and non-price-derived per-stage costs all commit normally. The Selector policy and Review Agent design wait until the repository is private.
- **Files:** New `docs/AGENTIC_EDITOR_REV2_FROZEN.md`; new `docs/PULPIT_ENGINE_EDITORIAL_STANDARD.md`; this plan (sanitized and verified per the private §5.0 manifest) as `docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md`; `DECISIONS.md`.
- **Migration:** None.
- **Tests:** `npm run verify`; before staging, run the private redaction check against the one sanitized plan file and inspect the staged diff. Confirm that §14 and §15 contain pointers only. Record the check result in the pull-request evidence without repeating withheld values or editorial logic.
- **Decision log:** Accepted architecture, rule precedence, continuous-source rule, general-policy learning rule.
- **Rollback:** Documentation-only revert. No runtime effect.
- **Trace:** Rev2 §§1–2, 7, 9, 10; product-owner Decisions 1–3; Addendum S18-iii.

### P0.3 — Add the benchmark-corpus contract

**Commit:** `test(editorial-eval): define the labeled benchmark manifest`

- **Outcome:** Create a private-media-safe format for human labels: sermon boundaries, forbidden content, slides, pastor visibility, clip boundaries, decision, and feedback.
- **Files:** New `evaluation/editorial-standard-v1.md`; new `evaluation/benchmark-manifest.schema.json`; new `evaluation/benchmark-manifest.example.json`; new `scripts/verify-editorial-benchmark.ts`; `package.json`; new `tests/editorial-benchmark.test.ts`.
- **Migration:** None.
- **Tests:** Valid manifest; missing checksum; invalid region; invalid decision; invalid continuous range. Do not commit church media — controlled artifact IDs and checksums only.
- **Decision log:** Only if a retention/privacy decision for benchmark artifacts is needed.
- **Rollback:** Remove the evaluator files. Runtime unchanged.
- **Trace:** Rev2 §§14–15; Addendum S12 and S18.

### P0.4 — Charter the current analyzer and scheduler before changing them

**Commit:** `test(analyze): charter current pool and scheduling behavior`

- **Outcome:** Make the current, post-`c1603cd` behavior executable evidence before `runAnalyzeJob` changes. The charter targets what the code actually does today, not the draft plan's pre-`c1603cd` description.
- **Files:** New `tests/integration/analyze-job.integration.test.ts`; optional helpers under `tests/integration/helpers/`.
- **Migration:** None.
- **Tests (named scenarios):**
  - `CANDIDATE_POOL_SIZE` 18 as a ceiling (`analyze.ts:15`, `:122`) and thin pools staying thin.
  - Window generation: ≤3 duration targets per start; even sampling (not front-truncation) when the pool exceeds the 500 cap; IoU>0.5 thinning before the 25-candidate Stage B slice.
  - Slot arming: `rank <= targetClipCount && project.sermonDate` (`analyze.ts:182`); null `sermonDate` skips arming (legacy-only — all new projects get one).
  - `scheduledDateForRank` = `sermonDate + rank` days — **including the current Sunday-spill behavior** (a Tuesday sermon schedules a Sunday post today). Charter it so P1.8's fix has a before/after.
  - Cross-project date collision behavior (no unique constraint exists; `slotAlreadyPublished` is the only guard — a race window).
  - The current destructive reanalysis transaction (`clearReschedulableScheduledPosts` + `generatedClip.deleteMany`, `analyze.ts:128-132`).
  - Current `keptCount` / `targetClipCount` metadata shape (`analyze.ts:212-217`).
  - **Stage A is the binding funnel constraint.** Assert the measured 2026-08-11 shape: ~500 candidate windows enter Stage A and `scoredCount` reaches Stage B in single digits. Charter the ratio, not the exact number, so the test is stable — it must fail if Stage A recall changes materially in either direction.
  - **Selected clips cluster in the opening of the service.** Assert that on the reference service every kept clip starts within the first 20 percent of the source duration (measured: 1:25–10:58 of 49:41). This is characterization of a *current limitation*, not an invariant to preserve. P5 exists to break it, and this test is the before-half of that comparison — when P5 lands, this assertion inverts rather than being deleted, so the improvement is provable.
- **Decision log:** None. This is characterization, not acceptance of the defects.
- **Rollback:** Test-only revert.
- **Trace:** Addendum S18-ii (named charter scenarios); implementation-guide ordering rule 3; P0.1's `c1603cd` catch-up entry.

### P0.5 — Add pure candidate-limit resolution

**Commit:** `feat(candidate-config): resolve master and hidden candidate limits`

- **Outcome:** Add master default and maximum controls with code fallbacks of 18. Add a reserved hidden church override input. Enforce the required scheduled count as the minimum. Keep the two concepts distinct: the **candidate limit** is the retained-pool ceiling (today's hard-coded 18); the **scheduled count** is `targetClipCount` (6, or 3 for two-service churches — currently module-private in `analyze.ts:31-37`, extracted or re-exported here so the resolver and later modules share one implementation).
- **Files:** New `src/lib/analysis/candidate-limit.ts`; `src/lib/jobs/handlers/analyze.ts` (export/move `readTargetClipCount`); `src/lib/env.ts`; `.env.example`; new `tests/candidate-limit.test.ts`; `tests/env.test.ts`.
- **Migration:** None.
- **Tests:** Default; maximum; lower override; invalid override; above-max override; below-required override; missing environment values.
- **Decision log:** None. P0.6 records the business meaning when persistence is added.
- **Rollback:** Unset the new environment values. The code fallback stays 18.
- **Trace:** Rev2 §5.1 and §13 P3; product-owner Decision 1 moves this control into the current build.

### P0.6 — Add the hidden staff-only church override

**Commit:** `feat(operations): manage hidden church candidate overrides`

- **Outcome:** Give trusted Pulpit Engine operations a CLI that can set or clear an override. No church route, setting, or dashboard.
- **Files:** New `src/lib/operations/candidate-limit-override.ts`; new `scripts/set-candidate-limit-override.ts`; `src/lib/workspace-settings.ts`; `package.json`; new `tests/integration/candidate-limit-override.integration.test.ts`; `DECISIONS.md`.
- **Migration:** None. Store the value in a protected internal subtree of `Workspace.settings` (writes via `updateWorkspaceSettings()`; reads must preserve `parseChurchProfile`'s never-throw pattern).
- **Tests:** Explicit workspace UUID; set; clear; invalid value; audit event; optimistic-concurrency retry; church settings write preserves the internal subtree; public settings read does not expose it.
- **Decision log:** The override is an internal capacity control, not a church-specific editing preference.
- **Rollback:** Clear the key with the same operations command. The resolver returns the master default.
- **Trace:** Product-owner Decision 1; Rev2 §5.1 as overridden.

### P0.7 — Snapshot candidate and service configuration on project creation

**Commit:** `feat(projects): snapshot candidate and service configuration`

- **Outcome:** At project creation, resolve and copy the effective candidate limit, scheduled count, timezone, configured service weekdays, service frequency, **service occurrence**, and configuration version into `Project.processingConfig`. There is effectively one write point — `buildDraftProjectRecord` / `buildDefaultProcessingConfig` in `src/lib/project-service.ts` — reached by both create paths (upload, and URL/channel import via `createDraftProjectForWorkspace`, which `channel-poller.ts` also calls). No separate channel-import change is needed. This deliberately resolves the addendum's earlier “at analysis” wording in favor of the accepted new-project-only rule and the repository's single creation-time snapshot boundary.
- **Known limitation (accepted):** occurrence is derived by `deriveServiceSlot`, which until P1.8 misfiles unmatched services as PRIMARY. Snapshots taken between P0.7 and P1.8 inherit that; P1.10's operator correction is the remedy for any that matter.
- **Files:** `src/lib/project-service.ts`; `src/lib/church-profile.ts`; `tests/project-service.test.ts`; `tests/church-profile.test.ts`.
- **Migration:** None.
- **Tests:** Upload path; URL/channel path; one-service snapshot; two-service snapshot; later workspace change does not change an existing snapshot; defensive read of legacy projects (missing keys → current defaults).
- **Decision log:** Candidate and schedule settings freeze when a project is created; later settings affect new projects only.
- **Rollback:** Legacy defensive defaults preserve current projects.
- **Trace:** Addendum repository constraint on `processingConfig` write points; S9; S10 (occurrence snapshot feeds P1.9's allocator).

### P0.8 — Use the dynamic limit in ANALYZE

**Commit:** `feat(analyze): honor the snapshotted candidate ceiling`

- **Outcome:** Replace the hard-coded `CANDIDATE_POOL_SIZE` with the defensive project snapshot. Keep "up to the limit." Never pad.
- **Files:** `src/lib/jobs/handlers/analyze.ts`; `tests/integration/analyze-job.integration.test.ts`; `tests/analysis-usage.test.ts`.
- **Migration:** None.
- **Tests:** Limit 18; lower valid override; thin pool; required schedule count higher than invalid override; legacy project fallback; metadata includes requested limit and retained count.
- **Decision log:** None.
- **Rollback:** Set the master default and maximum to 18. Normal behavior matches the old ceiling.
- **Trace:** Rev2 §§2.3 and 5; product-owner Decision 1.

### P0.9 — Block silent heuristic analysis in production

**Commit:** `fix(analysis): fail closed when the Claude provider is unavailable`

- **Outcome:** Close the live Addendum-S4 violation. Today `src/lib/analysis/index.ts:6-12` silently returns the $0 `HeuristicAnalysisProvider` whenever `ANTHROPIC_API_KEY` is missing, with no event. Define exact behavior: development and test without a key may use the heuristic provider automatically, but every result records provider=`heuristic`, model=`heuristic-v1`, and the selection reason. Production with a missing key, rejected credential, provider outage, or failed Claude call fails the ANALYZE job with a `JobFailureError` and an operational event. The only production fallback is the exact-string `ANALYSIS_ALLOW_HEURISTIC=true` emergency override; each use emits a visible warning event and labeled provenance. The override defaults false and is never an invisible degradation path.
- **Files:** `src/lib/analysis/index.ts`; `src/lib/jobs/handlers/analyze.ts` (provenance in metadata and failure event); `src/lib/env.ts`; `.env.example`; `docs/DEPLOYMENT.md`; new `tests/analysis-provider-selection.test.ts`. Keep the existing production web readiness failure for a missing or malformed `ANTHROPIC_API_KEY`; correct its documentation, but do not claim it protects the worker at job time. Railway's worker has no health check and can have a different environment from the web service.
- **Migration:** None.
- **Tests:** Production + missing key + override false → job fails with operational event; production + rejected key/provider failure + override false → job fails; production + override true → heuristic runs, emits a warning, and records labeled provenance; development/test + missing key → heuristic runs and is labeled without a flag; Claude success records its provider/model; web readiness continues to fail for a missing production key; no test confuses web readiness with worker runtime availability.
- **Decision log:** Record that normal production analysis fails closed. Development may use labeled heuristic output, and only the time-bounded, visible, logged production override may permit heuristic analysis during an incident.
- **Rollback:** Set `ANALYSIS_ALLOW_HEURISTIC=true` only as a time-bounded production incident action. Every affected analysis remains labeled. Remove the override after recovery; never silently revert the guard.
- **Trace:** Addendum S4; §5.5 cost gates; S18-iv (Claude-only for MVP).

### P0.10 — Add one typed COGS event contract

**Commit:** `feat(cost): define processing cost facts`

- **Outcome:** Define one event shape for paid and local work: stage, quantity, unit, unit cost, provider, **model and provider provenance**, bytes, CPU time, wall time, cache state, and attribution IDs.
- **Files:** New `src/lib/cost/types.ts`; new `src/lib/cost/record.ts`; `src/lib/observability/operational-events.ts`; `src/lib/analysis/usage.ts`; new `tests/cost-events.test.ts`.
- **Migration:** None. Use structured `OperationalEvent.metadata` for raw facts until Wave 1 lands.
- **Tests:** Paid event; zero-cost event; unknown price; retry; project/clip attribution; no `UsageLedger` write (note: its field is `minutesDelta` — the draft's `minutesCharged` reference was a different model's field).
- **Decision log:** COGS facts versus customer minute entitlements, if not already explicit.
- **Rollback:** Stop new event emission. Processing still works.
- **Trace:** Rev2 §12; Addendum S7 and telemetry constraints; P0.9 provenance requirement.

### P0.11 — Meter source intake and proxy bytes

**Commit:** `feat(cost): meter source acquisition and proxy traffic`

- **Outcome:** Record bytes, source duration, bitrate, proxy use, failures, retries, elapsed time, Railway service egress, and the configured price per GB. Today the only byte accounting in the yt-dlp path is the `--max-filesize` cap plus a post-download `stat` — nothing records transfer or attributes proxy cost.
- **Files:** `src/lib/media/ytdlp.ts`; `src/lib/jobs/handlers/finalize.ts`; `src/lib/channel-import-service.ts`; `src/lib/observability/operational-events.ts`; new `tests/ytdlp-cost.test.ts`; `tests/integration/url-import.integration.test.ts`; `DECISIONS.md`.
- **Migration:** None.
- **Tests:** Direct path; proxy path; failed transfer still records attributable bytes when known; retry; missing unit price becomes unpriced; no secret proxy URL in metadata.
- **Decision log:** The residential-proxy ADR's revisit trigger (`DECISIONS.md:1110`: >~$200/mo or >~25 churches) is now a measured launch gate.
- **Rollback:** Disable metering without changing the download path.
- **Trace:** Addendum Decision Q; repository ADR at `DECISIONS.md:1069-1134`.

### P0.12 — Meter transcription, analysis, render, and storage

**Commit:** `feat(cost): meter every current processing stage`

- **Outcome:** Emit cost facts for audio extraction, whisper.cpp, Claude calls, storage operations, downloads, uploads, and FFmpeg exports. Report local work with a zero API price and measured compute. Reconcile with — do not duplicate — the existing ANALYZE-usage-in-metadata path (`analyze.ts:204-207` + the `/app/settings/operations` rollup in `src/lib/analysis/usage.ts`).
- **Files:** `src/lib/jobs/handlers/transcribe.ts`; `src/lib/transcription/whisper-cpp-provider.ts`; `src/lib/analysis/claude-provider.ts`; `src/lib/jobs/handlers/analyze.ts`; `src/lib/exports/handler.ts`; `src/lib/storage/index.ts` or a metering decorator; `src/lib/env.ts`; `.env.example`; related unit and integration tests.
- **Migration:** None.
- **Tests:** `tests/analysis-usage.test.ts`; `tests/whisper-cpp-provider.test.ts`; `tests/storage-provider.test.ts`; `tests/integration/phase-6-7-workflow.integration.test.ts`; paid, local, failed, retried, and unpriced cases.
- **Decision log:** None.
- **Rollback:** Event emission can stop without changing work execution.
- **Trace:** Rev2 §§12 and 13 P0; Addendum S7.

### P0.13 — Stop automatic filler deletion

**Commit:** `fix(editor): preserve every spoken word by default`

- **Outcome:** Keep fillers by default. The defect chain, precisely: `filler-detection.ts:3` flags the lexicon (`um/umm/uh/uhh/erm/"you know"/"like"`) **and any word with confidence < 0.5** as `isFiller`; `isWordDeleted` in `src/lib/editor/types.ts:80-85` then treats filler as deleted unless explicitly restored; `buildDefaultEditorState` (reached at `src/lib/exports/handler.ts:74-76` for never-edited clips) therefore silently deletes words at export. After this commit the filler tag is metadata only; low confidence is never a deletion instruction; legacy documents remain readable until P1 blocks them from delivery.
- **Files:** `src/lib/transcription/filler-detection.ts`; `src/lib/editor/types.ts`; `src/lib/editor/words.ts`; `src/components/editor/script-editor-panel.tsx`; `src/components/clip-editor.tsx`; `tests/filler-detection.test.ts`; `tests/editor-words.test.ts`; `tests/editor-state.test.ts`; `DECISIONS.md`.
- **Migration:** None.
- **Tests:** Filler tag is metadata only; default state has no deletion; low-confidence word is kept; known discourse markers are kept; legacy explicit deletion still parses; **integration assertion in `tests/integration/phase-6-7-workflow.integration.test.ts`: a clip with no saved editor state exports with zero deleted words** — the actual harm path runs through `handler.ts:74-76`, so the fix must be proven at export, not just in editor units. Note `tests/editor-state.test.ts` ("treats filler words as deleted by default") and `tests/editor-words.test.ts` encode the OLD semantics — respecify against the new contract, don't edit until green.
- **Decision log:** Supersede the recorded default filler-removal decision. Correctness and faithfulness take priority.
- **Rollback:** Do not restore the unsafe default. If export breaks, hold export and fix forward.
- **Trace:** Rev2 §§2.5, 3.6; Addendum S18-iii; product-owner Decision 3.

Before this UI edit, read the relevant bundled Next 16 component and server/client guides.

### P0.14 — Correct the face-tracking claim

**Commit:** `fix(editor): describe current center-crop behavior accurately`

- **Outcome:** Remove the claim that face tracking runs during export (`layout-panel.tsx:10` "Tracks the speaker at render time"; `:102-107`). Reality: `src/lib/export/crop.ts:31-40` routes both `"center"` and `"face"` to `computeCenterCrop`; no face-detection code exists in `src/`.
- **Files:** `src/components/editor/layout-panel.tsx`; relevant assertion in `tests/e2e/phase-6-7-reviewed-export.spec.ts`.
- **Migration:** None.
- **Tests:** Browser copy assertion; existing crop test continues to prove center fallback.
- **Decision log:** None.
- **Rollback:** Copy-only revert, but do not restore a false product claim.
- **Trace:** Rev2 §3.8 and §13 P0.

Before this UI edit, read the relevant bundled Next 16 guide.

### P0.15 — Combined preflight: schedule collisions and historical-export census

**Commit:** `fix(schedule): fail closed on duplicate posting dates and census legacy exports`

- **Outcome:** Two preflights that Wave 1 depends on. (a) Find current duplicate workspace/date rows before the unique constraint exists; during analysis, the earlier-armed project keeps the date and the later project records an operator-visible collision. (b) Census historical exports: how many SUCCEEDED exports have no provable edit version, which armed `ScheduledPost` rows are backed only by them, and which clips have demoted approvals with still-publishable exports. The census output feeds P0.17's legacy-ineligibility decision entry with a known blast radius.
- **Files:** New `scripts/audit-scheduled-post-collisions.ts`; new `scripts/audit-legacy-exports.ts`; `src/lib/jobs/handlers/analyze.ts`; `src/lib/scheduling.ts`; `src/lib/observability/operational-events.ts`; `package.json`; `tests/integration/analyze-job.integration.test.ts`.
- **Migration:** None.
- **Tests:** No collision; collision; earlier row wins; later project stays analyzed; operational event; no silent suppression; census counts on seeded data.
- **Decision log:** None. The final scheduling decision is recorded in P1.9; the legacy-export decision in P0.17.
- **Rollback:** Keep both audit scripts. Revert handler behavior only before Wave 1 uniqueness exists.
- **Trace:** Addendum S10 and Wave 1 precondition; deployment step 6.

### P0.16 — Global publisher kill switch

**Commit:** `feat(publishing): add a repository-visible global publish disable`

- **Outcome:** Add `AUTOMATIC_PUBLISHING_ENABLED` as a positive-enable global switch. Missing, malformed, or any value other than the exact string `true` means disabled. Enforce it at the start of `publishDueScheduledPosts()` itself, not only in `src/worker/run-jobs.ts`, because scripts and tests can call the publisher directly. The worker loop can skip the call as an optimization, but the publisher is the authority. Keep the switch false from this commit through all of P1 and P2 sandbox preparation. Prepare one manual pinned sandbox render, pass QC, record exact human `ACCEPT`, and prove every eligibility input except this switch. Then temporarily set true for one controlled sandbox publication. Keep it true only if the exact accepted export succeeds; set it false immediately on any failure or identity mismatch. P1.11 later consumes the same fact in the Delivery Eligibility Module.
- **Files:** `src/lib/integrations/facebook-publisher.ts`; `src/worker/run-jobs.ts`; `src/lib/env.ts`; `.env.example`; `src/lib/deployment/readiness.ts` (document the state; do not make `true` a readiness requirement); `docs/DEPLOYMENT.md`; `tests/worker-reliability.test.ts`; publisher unit/integration tests.
- **Migration:** None.
- **Tests:** Missing/false/malformed → no new external claim and no Meta call; exact true → normal guarded path; direct function call cannot bypass the switch; worker-loop call cannot bypass it; stale-post inspection/reconciliation remains safe while disabled; one operational event reports the disabled state without flooding.
- **Decision log:** Record the switch and its precedence (kill switch beats every other publish gate).
- **Rollback:** Set false or unset to disable. A code rollback that removes this guard is unsafe unless the Meta token is removed first or every workspace auto-post flag is disabled. The switch cannot cancel a Meta request already in flight, so deployment and rollback inspect `IN_PROGRESS` rows.
- **Trace:** Addendum S1 (gate-at-publish); P0.17 deploy runbook step 1; P1.11/P1.12 rollback notes.

### P0.17 — Deploy Migration Wave 1

**Commit:** `db(agentic-editor): add correctness substrate wave one`

- **Outcome:** Add forward-compatible schema that P1 and early P2 will use. Old web and worker code must still run after this migration.
- **Files:** `prisma/schema.prisma`; new `prisma/migrations/<timestamp>_agentic_editor_wave_1/migration.sql`; `prisma/seed.ts` if needed (match the existing per-model seed pattern — it is find-or-create/upsert-mixed, not uniformly upsert); `DECISIONS.md`.
- **Migration (Wave 1 contents — the authoritative list; consumer audit in Appendix A):**
  - `ExportJob.editVersion` (nullable Int) — consumers P1.1, P1.2, P2.4, P2.7, and P2.8. Historical rows stay null because their version cannot be proven.
  - `ExportJob.priority` (Int, default 0) — first consumer: P2.7 replacement render and its `claimNextExportJob` ordering change (`priority desc, createdAt asc`; `runAfter` already exists). P3 explicit fill reuses it.
  - Render-QC result fields + QC-time checksum — consumers P1.3, P1.11, P2.5, and P2.8. **Checksum single source of truth:** `ExportedFile.checksum` already exists; the QC record stores the checksum computed at QC time and asserts equality with `ExportedFile.checksum` at upload. Eligibility and review always compare that one verified value.
  - **`ServiceSlot.UNMATCHED @map("unmatched")`** — consumers P1.8, P1.9, and P1.10. Old code never writes this new value, so the expand-first migration remains compatible; dependent code ships later.
  - `GeneratedClipStatus.SUPERSEDED` + `GeneratedClip.supersededAt` — consumers P1.11, P2.7, and P3 read models.
  - `SchedulePublishStatus.BLOCKED`, `UNFILLED`, `MISSED` — consumers P1.9, P1.11, P2.4.
  - **`ScheduledPost.exportJobId` (nullable, unique FK to `ExportJob`, `onDelete: SetNull`)** — the exact one-to-one export binding. Add the named inverse relation on `ExportJob`; the unique field supplies its lookup index. Consumers P1.11 (fail closed on null), P1.12 (publish intent), P2.4 (coordinator writes it at enqueue), P2.5 (plays exactly it), P2.7 (replacement rebind), P2.8 (acceptance), and P3 explicit fill. Historical slots remain null. Every consumer also verifies matching workspace and clip; the FK cannot enforce those cross-row facts. Without this column every consumer re-derives "latest matching export," recreating the publisher defect.
  - **`ScheduledPost.projectId` (nullable FK to `Project`, `onDelete: SetNull`)** — backfill from the current clip's project when available. New P1 scheduling writes always set it. This gives an `UNFILLED` slot durable project ownership when `clipId` is null and preserves the intended service project if P3 explicitly fills the slot from an older project. Historical detached rows may remain null and fail closed where project identity is required.
  - **Partial unique index for one non-`MISSED` `(workspaceId, scheduledDate)` row** — `NOT_STARTED`, `IN_PROGRESS`, `SUCCEEDED`, `FAILED`, `BLOCKED`, and `UNFILLED` all reserve the date; only `MISSED` does not. `SUPERSEDED` is a clip state, and no `CANCELLED` schedule state exists. Replacement mutates the existing slot instead of creating a second row. `MISSED` is terminal for automation; an explicit operator reschedule mutates that same row to a new date/status rather than inserting a second row with the same unique `clipId`. P0.15's collision audit must run in production first.
  - `OperationalEvent.clipId` — consumers: P0.18 rollup attribution, P1.3 QC-failure events, P1.12 publish events.
  - `DailyCostRollup` — consumer P0.18.
  - Append-only publish-attempt/intent storage (`PublishAttempt`: scheduledPostId, expectedClipId, expectedExportJobId, state, provider post id, timestamps) — consumer P1.12.
  - **`EditorialException`** (moved from Wave 2 — no ClipReview dependency) — include an explicit append-safe `OPEN`/`RESOLVED` lifecycle, resolution time, resolution actor/reason, immutable project/slot snapshots, and nullable live links. Consumers: P1.9 (UNFILLED/notify), P1.12 (indeterminate outcomes), later P2/P3/P6. Resolution closes an exception; it does not delete its evidence.

The inspected Wave 1 migration must express the date rule exactly:

```sql
CREATE UNIQUE INDEX "scheduled_posts_one_non_missed_date_idx"
ON "scheduled_posts" ("workspace_id", "scheduled_date")
WHERE "publish_status" <> 'missed'::"schedule_publish_status";
```
- **Tests:** Clean migration; production-shaped upgrade; legacy null export; one-to-one binding and `SET NULL`; `ScheduledPost.projectId` backfill and null historical row; workspace/clip/project mismatch refusal in consumer contracts; exception open/resolve history; `UNMATCHED` enum round trip; duplicate-date preflight; exact non-`MISSED` partial-index matrix; Prisma validation; all integration tests; worker image build.
- **Decision log:** Expand-first migration; legacy exports (null `editVersion`) are permanently delivery-ineligible (blast radius from P0.15's census); active-date uniqueness.
- **Rollback:** Leave additive schema in place and roll application code back. Remove an index only through a new forward migration.
- **Trace:** Addendum S1, S7, S8 (wave contents amended per Appendix A); §7 migration constraints.

Operational deploy order for this commit:

1. Set the P0.16 kill switch (disable automatic publishing).
2. Run the P0.15 collision and legacy-export audits against production.
3. Drain workers.
4. Generate with `--create-only` and remove the two known bad tsvector statements.
5. Deploy the web migration.
6. Deploy the compatible worker.
7. Resume workers. Keep `AUTOMATIC_PUBLISHING_ENABLED=false` through all of P1. Wave 1 smoke checks do not authorize publication.

### P0.18 — Build daily cost rollups and harden the worker tick loop

**Commit:** `feat(cost): roll up daily COGS and isolate periodic worker blocks`

- **Outcome:** Two things. (a) Replace the current 1,000-row scan limit (`SPEND_EVENT_SCAN_LIMIT` in `src/lib/analysis/usage.ts:83`, computed on-read for the operations page) with idempotent daily stage totals in `DailyCostRollup`, plus a project cost report for operations. (b) **Per-block error isolation in `src/worker/run-jobs.ts`:** today one try/catch wraps all periodic blocks, so a throwing new block (like this rollup) would starve the publisher and cleanup every tick. Each block gets its own catch that records an operational event and continues.
- **Files:** New `src/lib/cost/rollup.ts`; `src/worker/run-jobs.ts`; `src/app/app/settings/operations/page.tsx`; new `scripts/report-project-cost.ts`; `package.json`; new `tests/cost-rollup.test.ts`; new `tests/integration/cost-rollup.integration.test.ts`; worker unit test for isolation.
- **Migration:** Uses Wave 1 `DailyCostRollup` and `OperationalEvent.clipId`.
- **Tests:** Idempotent rerun; late event; retry cost; unknown price; workspace isolation; reconcile existing ANALYZE metadata without double counting; more than 1,000 raw events; **one failing periodic block does not suppress the next block**.
- **Decision log:** None.
- **Rollback:** Stop the rollup interval. Raw events remain the source data.
- **Trace:** Addendum S7 and telemetry constraints; Rev2 §12; §7 worker rules.

Before this UI edit, read the relevant bundled Next 16 data-fetching and server-component guides.

### P0.19 — Prove one real-service cost report

**Commit:** `docs(cost): add and pass the P0 cost-truth gate`

- **Outcome:** Add a repeatable runbook and validator. Execute it on one real service. Store measured totals without secrets or private media. The report must include provider/model provenance per stage (P0.9/P0.10) and the production storage provider + contracted egress price (settling Addendum S2 now, not at P4). Reconcile against the §5.6 sandbox anchors.
- **Files:** New `docs/P0_COST_TRUTH_RUNBOOK.md`; new `scripts/verify-project-cost-report.ts`; `package.json`; new `tests/cost-report.test.ts`; `DECISIONS.md` after the real run.
- **Migration:** None.
- **Tests:** Missing stage; unpriced paid unit; duplicate charge; retry; valid complete report; monthly projection.
- **Decision log:** Actual proxy bytes, cost per source hour, core cost per service, storage provider + egress price, and whether Gate A passed.
- **Rollback:** None. This is an evidence checkpoint.
- **Trace:** Addendum Decision Q, S2, S4; implementation-guide ordering rule 3.

**Hard stop:** Do not approve YouTube economics unless the real contracted proxy result is at or below the stated intake gate.

### P0.20 — Validate the plan grid against church usage

**Commit:** `docs(billing): expose plan-grid conflicts for decision`

- **Outcome:** Prove whether each plan can process its advertised source limits and the light, typical, and heavy profiles. Do not silently change customer entitlements. Verified facts the script must encode: the free tier's 60-minute balance cannot process the 90-minute video it nominally permits (`plans.ts:20` cap vs. `estimateProcessingMinutes` ceil-per-minute reservation failing at FINALIZE); starter's 300 min/mo cannot serve a weekly church at ≥ ~70 min/service (300 ÷ 4.33 ≈ 69.2); **granted minutes accumulate across Stripe invoices with no reset**, which softens but does not fix the steady-state deficit; `overageAllowed` is declared and never read (dead field); prices live in Stripe env vars, not code; and the upload-presign gate checks only balance > 0, so a low-balance church burns a full upload before `INSUFFICIENT_MINUTES` at FINALIZE (cheap UX win to note for Jake's decision).
- **Files:** New `scripts/validate-plan-grid.ts`; `src/lib/billing/plans.ts` only if Jake selects a new grid in a later commit; new `tests/billing-plans.test.ts`; `docs/BUSINESS_OVERVIEW.md`; `DECISIONS.md`.
- **Migration:** None.
- **Tests:** Free versus maximum video; weekly 70-, 90-, and typical-profile usage; accumulation behavior; hard-block behavior; proposed plan alternatives.
- **Decision log:** The measured conflict. A later small commit records Jake's chosen pricing or entitlement response.
- **Rollback:** Report-only until a business choice is made.
- **Trace:** Addendum Decision R.

### P0 exit criteria

- The repository-visibility policy and its P5 trigger are recorded, and no strategy or margin document has entered public history.
- The tree is clean and the decision log is current (P0.1).
- The accepted policy is in the repository.
- The benchmark format works.
- The current analyzer/scheduler behavior is chartered, including Sunday spill and the destructive-reanalysis transaction.
- Candidate default, maximum, hidden staff override, and per-project snapshot (including occurrence) work.
- New analysis honors the dynamic ceiling and does not pad.
- **Production analysis can no longer silently degrade to the heuristic provider.**
- Default edits keep every word — proven at export, not just in the editor.
- The UI does not claim face tracking.
- A repository-visible publish kill switch exists.
- Wave 1 is deployed safely, including the ScheduledPost→ExportJob binding and `EditorialException`.
- One real service passes Gate A, including storage/egress and provenance facts.
- The plan-grid conflict is ready for Jake's separate business decision.


---

## 10. P1 — Correctness substrate (12 commits)

P1 makes the current renderer, scheduler, and publisher safe. Automatic delivery remains globally disabled (P0.16 switch) until P2 supplies an exact human acceptance.

### P1.1 — Make the worker able to render a pinned edit version

**Commit:** `feat(exports): render an explicitly pinned edit version`

- **Outcome:** If `ExportJob.editVersion` is set, load exactly that version. Define version 0 as the immutable implicit default when no edit row exists. Do not guess a version for a historical null job. (Today `handler.ts:70-76` loads `orderBy: { version: "desc" }` — the latest edit at render time, whatever the POST validated. `ClipEdit.version` with optimistic concurrency already exists and is the version being pinned; this is about binding the *export* to one of them.)
- **Files:** `src/lib/exports/queue.ts`; `src/lib/exports/handler.ts`; new `src/lib/editor/edit-version.ts`; `tests/enqueue-idempotency.test.ts`; `tests/integration/phase-6-7-workflow.integration.test.ts`.
- **Migration:** Uses Wave 1 nullable `editVersion`.
- **Tests:** Version 0; exact version; newer edit exists but is ignored; missing pinned version fails; legacy null is ineligible for delivery.
- **Decision log:** None. P1.2 records the external behavior reversal.
- **Rollback:** Keep the legacy nullable code path for manual investigation. Do not make null exports automatically eligible.
- **Trace:** Rev2 §3.1; Addendum known defect sites.

**Built 2026-08-20 (PR #42, merged `9c0e8fc`).** `loadPinnedEditorState` lives in
`src/lib/exports/edit-version.ts`, not `src/lib/editor/` — it reads the database, so it belongs
with the orchestration modules. The export route stores `editVersion` on the `ExportJob` row and
`runExportJob` loads the document through `job.editVersion`, so a job renders the edit it was asked
for even when newer edits were saved between the request and the run.

### P1.2 — Pin new exports and remove filename from idempotency

**Commit:** `fix(exports): bind one export job to one edit version`

- **Outcome:** Enqueue the exact current edit version. Use `export:{clipId}:v{editVersion}` as identity. Treat filename as metadata, not new work. The defect is worse than "user-supplied filenames create duplicates": the UI never sends a filename (`export-panel.tsx` posts `{}`), so the server builds the default via `buildDefaultExportFilename(..., date: new Date())` — **the key embeds today's date and silently rotates at midnight** for the same clip and version. Also note the idempotency lookup currently returns before `checkExportJobLimits`, so the key shape directly controls rate-limit exposure — preserve that ordering deliberately or change it deliberately, with a test either way.
- **Files:** `src/app/api/clips/[id]/exports/route.ts`; `src/lib/exports/queue.ts`; `src/lib/export/filename.ts`; `tests/enqueue-idempotency.test.ts`; `tests/export-filename.test.ts`; `tests/integration/route-authorization.integration.test.ts`; `DECISIONS.md`.
- **Migration:** Uses Wave 1.
- **Tests:** Double click; next-day re-enqueue of the same clip+version returns the same job; renamed file; same edit; new edit; concurrent enqueue P2002 race; exact version stored. (No existing test asserts the key shape — `tests/enqueue-idempotency.test.ts` uses a fake key — so this commit *adds* the key-format coverage rather than respecifying it.)
- **Decision log:** Supersede `DECISIONS.md:599` (idempotency scoped to clip + edit version + filename).
- **Rollback:** Old jobs remain readable. Do not restore filename identity — it creates unlimited renders.
- **Trace:** Rev2 §3.1; Addendum §5 known defect.

**Built 2026-09-02 (PR #53, merged `ea6f9f7`).** Identity is `export:{clipId}:v{editVersion}`;
the filename is metadata. Recorded in `DECISIONS.md` as "An Export Is Identified By Its Clip And
Its Edit Version, And Nothing Else" (2026-09-02).

### P1.3 — Make basic render QC mandatory

**Commit:** `fix(exports): fail jobs when output validation fails`

- **Outcome:** A successful export must decode, contain audio and video, have the expected vertical dimensions, valid duration, nonzero bytes, and a checksum. Do not swallow the probe error or invent dimensions (today `handler.ts:170-174` does `probeVideoFile(...).catch(() => null)` and `:187-188` substitutes the 1080×1920 constants; checksum and bytes are already real — only dimensions are fabricated). Output is not uploaded before QC passes. QC failures emit operational events carrying the new `OperationalEvent.clipId`.
- **Files:** New `src/lib/qc/render-output.ts`; `src/lib/media/probe.ts`; `src/lib/exports/handler.ts`; `src/lib/exports/runner.ts`; `tests/probe.test.ts`; new `tests/render-output-qc.test.ts`; new `tests/integration/render-output-failures.integration.test.ts`; `tests/integration/phase-6-7-workflow.integration.test.ts`; `DECISIONS.md`.
- **Migration:** Uses Wave 1 QC/checksum fields (QC-time checksum asserted equal to `ExportedFile.checksum` — the single source of truth).
- **Tests:** Corrupt file; missing audio; wrong dimensions; wrong duration; zero bytes; valid output; checksum persistence and equality assertion; no upload before QC passes.
- **Decision log:** `SUCCEEDED` now means the file passed mandatory validation.
- **Rollback:** Hold exports. Never restore a swallowed probe failure.
- **Trace:** Rev2 §3.5, §4.8; Addendum known defect.

**Built 2026-09-02 (PR #54, merged `8e7ab42`).** `src/lib/qc/render-output.ts` is the module;
nothing uploads before it passes. No migration was needed — Wave 1 had already added `qcStatus`,
`qcCheckedAt`, `qcChecksum` and `qcDetails`. Recorded in `DECISIONS.md` as "A Successful Export Is
One That Proved Itself Before It Was Stored" (2026-09-02). Slice 13 later confirmed the module
needed no extension for export parity.

### P1.4 — Remove creation of internal word cuts

**Commit:** `fix(editor): limit new edits to continuous-source controls`

- **Outcome:** Remove word-delete and filler-delete controls for all users, including Jake. Keep legacy documents readable. Add an explicit conversion that clears old deletion lists into a new continuous version. The drag-to-trim timeline (`clip-timeline.tsx` + `src/lib/editor/trim.ts`, `MIN_CLIP_MS` 3s, snap-to-word-boundary) is the allowed edit surface — build on it, don't replace it. Side benefit: this collapses the current preview/export divergence (`video-preview.tsx` skips deleted words with its own logic, independent of `computeKeptRanges` — two implementations of "what survives" become one trivial one).
- **Files:** `src/components/editor/script-editor-panel.tsx`; `src/components/clip-editor.tsx`; `src/lib/editor/types.ts`; new `src/lib/editor/continuous-edit.ts`; `src/components/editor/video-preview.tsx`; `tests/editor-words.test.ts`; `tests/editor-state.test.ts`; `tests/e2e/phase-6-7-reviewed-export.spec.ts`.
- **Migration:** None.
- **Tests:** No delete control; start/end trim still works; crop/caption still work; legacy state parses; conversion creates a new version; stale-version conflict remains enforced (`EDIT_STATE_CONFLICT` 409 path already exists).
- **Decision log:** None. P1.5 records the delivery invariant.
- **Rollback:** UI can be removed, but P1.5 remains authoritative.
- **Trace:** Rev2 §2.5; product-owner Decision 3; Addendum S18-iii.

Before this UI edit, read the relevant bundled Next 16 server-action, form, and component guides.

**Built 2026-08-21, inside editor Slice 5 (PR #47, merged `01860fa`; the transcript model is
`f504c6e`).** The word-delete control is gone and the editor cannot create an internal cut. Two
departures from the bullets above. There is no `src/lib/editor/continuous-edit.ts`: the explicit
conversion is `restoreAllDeletedWords` in `src/lib/editor/transcript.ts`, reached from the "Restore
all deleted words" control, and it is a versioned edit the member asks for rather than an automatic
conversion, because word ids are positional and a silent rewrite could repoint them. And the slice
added `wordEdits.textOverrides` (`{ wordId, text }`), so a mis-heard word can be corrected without
touching its timing or the clip's range. Recorded in `DECISIONS.md` as "A Transcript Correction
Changes What A Word Says, Never What The Clip Contains" (2026-08-20).

### P1.5 — Enforce one continuous range at export

**Commit:** `fix(render): reject all deliverable internal cuts`

- **Outcome:** Render exactly one interval from source start to source end. Reject any new or legacy state that still contains a middle deletion (`CONTINUOUS_RANGE_REQUIRED`). Caption every word in range without concatenating time. This retires the multi-segment concat path (`computeKeptRanges` → N+1 re-encodes + concat in `render.ts:65-152`) for deliverables; a single range also removes two of the three ffmpeg passes for the common case. Note: no existing test covers multi-range concat, so removal is low-risk; `tests/export-kept-ranges.test.ts` encodes the OLD semantics and is respecified, not edited until green.
- **Files:** `src/lib/exports/handler.ts`; `src/lib/export/render.ts`; `src/lib/export/kept-ranges.ts`; `src/app/api/clips/[id]/exports/route.ts`; `tests/export-kept-ranges.test.ts`; `tests/export-render.test.ts`; `tests/integration/phase-6-7-workflow.integration.test.ts`; `tests/e2e/phase-6-7-reviewed-export.spec.ts`; `DECISIONS.md`.
- **Migration:** None.
- **Tests:** One range; internal deletion rejected as `CONTINUOUS_RANGE_REQUIRED`; boundary trim allowed; captions stay aligned (watch the word-straddle rule: `wordsInRange` includes a word whose start lands inside the range even if it ends past the trim-out point); Jake-revised export; automatic default export; legacy conversion then export.
- **Decision log:** Supersede internal-cut behavior. Record the product statement about selecting, not rewriting.
- **Rollback:** Hold affected exports and use the converter. Never restore concatenated delivery.
- **Trace:** Rev2 §§2.5 and 3.6; product-owner Decision 3.

**Built in two parts.** The gate landed with Slice 5 (`1d4b8e3`, PR #47, 2026-08-21) in
`src/lib/exports/continuous-range.ts`: the worker refuses a pinned document that would render as
more than one span before it downloads anything, and the route answers the same question at
request time. `DECISIONS.md` records it on 2026-08-20 as "The P1.4 Continuous-Range Export Gate
Landed Early, With Slice 5" — that entry numbers the gate as P1.4; it is this commit's gate. The
renderer followed on 2026-09-05: `src/lib/export/render.ts` runs one ffmpeg pass over the clip's
one range, `src/lib/exports/render-plan.ts` carries `range` rather than `keptRanges` and asserts
the gate itself, and `toOutputTimeline` in the new `src/lib/export/output-timeline.ts` replaces
`mapToKeptTimeline`. `computeKeptRanges` stays as the gate's arithmetic only.
`tests/export-kept-ranges.test.ts` is respecified as that; `tests/export-output-timeline.test.ts`
and the `buildExportFfmpegArgs` tests in `tests/export-render.test.ts` are new; the parity gate
is the regression net. Recorded in `DECISIONS.md` as "An Export Is One Range In One Pass". One
departure from the bullets: `src/lib/export/kept-ranges.ts` is kept, not deleted, because the
gate's refusal is decided against the ranges a cut would leave.

### P1.6 — Give caption overrides stable identity

**Commit:** `fix(captions): anchor overrides to source words`

- **Outcome:** Replace positional `line-N` write identity (`caption-lines.ts:34`) with a stable source-word anchor and deterministic hash. Continue to read legacy IDs, but write only stable IDs. Verified: nothing in the repo writes `textOverrides` today (`buildDefaultEditorState` always emits `[]`; only reads exist), so the re-key is migration-free — but the PUT edit-state route accepts arbitrary documents, so dual-read stays as protection for anything hand-crafted.
- **Files:** `src/lib/editor/caption-lines.ts`; `src/lib/editor/types.ts`; `src/components/editor/video-preview.tsx`; `src/components/clip-editor.tsx`; `tests/caption-lines.test.ts`; `tests/edit-state-conflict.test.ts`.
- **Migration:** None.
- **Tests:** Boundary shift; regrouped lines; correction stays on the intended words; legacy read; new stable write; no ID collision.
- **Decision log:** None.
- **Rollback:** Dual-read permits code rollback. Do not write new positional IDs.
- **Trace:** Rev2 §3.7; implementation-guide ordering rule 3 (re-key before any caption tooling).

Before this UI edit, read the relevant bundled Next 16 guide.

**Status 2026-09-05: not started. The finding above still holds, with one addition.**
`caption-lines.ts:34` still writes `line-${index}`, and nothing in `src/` writes
`captions.textOverrides` — only two test fixtures do (`tests/caption-lines.test.ts`,
`tests/e2e/editor-caption-grid.spec.ts`), both with `line-0`. The addition: Slice 5 created a
second, word-keyed override list, `wordEdits.textOverrides` (`{ wordId, text }`, keyed by the
transcript's `segmentId:index`), and that is what the Script panel writes. It is stable across
trims and regroupings and moves only on re-transcription; it is not in this commit's scope. This
commit is about the line-keyed list that the preview and the render plan both read through
`applyCaptionTextOverrides`. `src/components/clip-editor.tsx` and `tests/edit-state-conflict.test.ts`
in the file list are probably untouched — verify by reading the tree.

### P1.7 — Block destructive reanalysis after durable work starts

**Commit:** `fix(analyze): preserve reviewed and exported clip identity`

- **Outcome:** Permit destructive reanalysis (today: `scriptureReference.deleteMany` + `clearReschedulableScheduledPosts` + `generatedClip.deleteMany`, `analyze.ts:125-132`) only when no material edit, approval, export, in-flight/published post, or other durable work exists. P2 adds `ClipReview` to the same policy.
- **Files:** New `src/lib/analysis/reanalysis-policy.ts`; `src/lib/jobs/handlers/analyze.ts`; `src/app/api/videos/[id]/srt/route.ts`; `src/lib/jobs/handlers/transcribe.ts`; new `tests/reanalysis-policy.test.ts`; `tests/integration/analyze-job.integration.test.ts`; `DECISIONS.md`.
- **Migration:** None.
- **Tests:** New untouched project allowed; material edit blocks; export blocks; approval blocks; publishing blocks; transaction leaves all rows unchanged on refusal; route and handler agree.
- **Decision log:** Block-now/versioned-analysis-later policy.
- **Rollback:** Disable reanalysis entirely. Do not restore destructive deletion after history exists.
- **Trace:** Rev2 §3.3; Addendum Decision C and S9.

### P1.8 — Add a pure weekday Posting Schedule Module and fix unmatched service derivation

**Commit:** `feat(schedule): allocate configured weekday posting slots`

- **Outcome:** Two pure changes with no production caller yet. (a) A DB-free allocator from church timezone, configured service weekdays, service occurrence, sermon date, and current date. (b) **Fix `deriveServiceSlot`** (`church-profile.ts:115-121`): explicitly compare the configured primary day, then the configured secondary day when present, and otherwise return `UNMATCHED` — including for a one-service church. Use this one name everywhere. Export `weekdayNameInTimezone` (currently module-private) for the allocator. Note `Project.serviceSlot` is written today but read by nothing — P1.9 becomes its first consumer.
- **Files:** New `src/lib/schedule/posting-schedule.ts`; `src/lib/church-profile.ts`; `tests/scheduling.test.ts` (respecified — it encodes rank→date arithmetic today); `tests/church-profile.test.ts`.
- **Migration:** Uses Wave 1 `ServiceSlot.UNMATCHED`; this commit does not add a migration.
- **Tests:** Sunday off; all one-service weekdays; non-Sunday/Wednesday two-service pairs (S11 table tests); church-local DST and month/year edges; null sermon date; unmatched one-service and two-service dates return `UNMATCHED` (not PRIMARY); passed date becomes `MISSED`; earlier-armed collision rule.
- **Decision log:** None until integration changes production behavior.
- **Rollback:** No caller yet.
- **Trace:** Rev2 §4.2; Addendum S10 and S11.

### P1.9 — Integrate the allocator, explicit slot states, and safe retention activation

**Commit:** `feat(schedule): arm explicit weekday slots during analysis`

- **Outcome:** Keep arm-at-ANALYZE (S1). Add `AUTOMATIC_SCHEDULE_ARMING_ENABLED`, default false for deployment of this behavior; when false, analysis retains candidates but creates no new schedule rows and records the disabled state. Read the P0.7 project snapshot (not the live profile). Every new slot writes its owning `projectId`, including an `UNFILLED` slot with no clip. Exclude Sunday. Mark past dates `MISSED`. Leave `UNMATCHED` services reserve-only (legacy PRIMARY-misfiled snapshots are corrected by operators via P1.10 when they matter). Record collisions as operational events, never silent suppression. UNFILLED slots create an `EditorialException` (Wave 1) and notify the operator. Enable schedule arming only after the new allocator passes its production-safe smoke test.
  **Retention activation, staged:** set `Project.expiresAt` = last planned post + 14 days (S6b). Add `SOURCE_RETENTION_DELETION_ENABLED`, default false. False means report-only and deletes nothing. This is the first code ever to set `expiresAt` — the entire CLEANUP source-purge path has zero production mileage, and the four storage keys are hard-coded in two places (`retention.ts:82-89` scan predicate and `cleanup.ts:52-57`/`:65` handler). Verify the two four-key lists still match every key FINALIZE/PROBE writes; run at least one complete report-only cycle in production; only then set the exact switch true. Before deleting source objects, CLEANUP must lock the `SourceVideo` row, re-read every referencing project's expiration under that lock, delete and null the source keys before releasing the lock, and then commit. Any replacement or P3 prior-service fill must take the same row lock before extending `expiresAt`. This closes the otherwise-live race where cleanup reads an expired project while an operator concurrently extends retention. `expiresAt` must be pushed out when the schedule extends (replacement/promotion).
- **Files:** `src/lib/jobs/handlers/analyze.ts`; `src/lib/scheduling.ts` (compatibility facade); `src/lib/observability/operational-events.ts`; `src/lib/retention.ts`; `src/lib/jobs/handlers/cleanup.ts`; `src/lib/env.ts`; `.env.example`; `docs/DEPLOYMENT.md`; `src/app/app/calendar/page.tsx`; `tests/integration/analyze-job.integration.test.ts`; `tests/integration/retention-cleanup.integration.test.ts`; `DECISIONS.md`.
- **Migration:** Uses Wave 1 schedule states, partial unique active date, and `EditorialException`.
- **Tests:** Schedule switch false → no rows and one visible fact; switch true → one service schedules six and two services schedule three each; configured weekday variants; Sunday exclusion; thin pool creates `UNFILLED` + exception; unmatched service stays reserve-only; collision; late upload skips (no shift); no spill; null date; retention date set and extended on schedule change; missing/false retention switch deletes nothing while reporting what it would delete; exact true permits the seeded purge integration case; source-row lock forces cleanup to re-read a concurrent retention extension before deletion.
- **Decision log:** Supersede rank-plus-date scheduling. Record skip-don't-shift, configured-day behavior, and the staged retention activation.
- **Rollback:** Set `AUTOMATIC_SCHEDULE_ARMING_ENABLED=false`. Do not return to rank arithmetic. Set `SOURCE_RETENTION_DELETION_ENABLED=false` to return to report-only.
- **Trace:** Rev2 §§2.4 and 4.2; Addendum S1, S6b, S10, S11; Decisions O and P.

Before this UI edit, read the relevant bundled Next 16 server-component guide.

### P1.10 — Capture and correct service occurrence before scheduling

**Commit:** `feat(projects): require service date and occurrence context`

- **Outcome:** Ask direct uploads for sermon date and service occurrence (`PRIMARY`, `SECONDARY`, or `UNMATCHED`). Permit correction only before the reanalysis-policy boundary. State that profile changes affect new projects only (S9 helper text). This is also the remedy for legacy snapshots misfiled as PRIMARY before P1.8.
- **Files:** `src/components/upload-dropzone.tsx`; `src/app/api/uploads/[uploadId]/complete/route.ts`; `src/app/actions/projects.ts`; `src/lib/project-service.ts`; new `src/components/project-service-context-form.tsx`; `src/app/app/projects/[id]/page.tsx`; `tests/project-service.test.ts`; `tests/integration/route-authorization.integration.test.ts`; new `tests/e2e/project-service-context.spec.ts`.
- **Migration:** None. `Project.sermonDate` and `serviceSlot` already exist.
- **Tests:** Valid date; missing date; primary; secondary; unmatched; authorized correction; correction after durable work refused; settings helper text.
- **Decision log:** None.
- **Rollback:** Require an operations correction. Do not silently use ingestion time.
- **Trace:** Addendum S9 and S10; repository null-date constraint.

Before this UI edit, read the relevant bundled Next 16 form, route-handler, and server-action guides.

### P1.11 — Add one Delivery Eligibility Module

**Commit:** `feat(delivery): centralize fail-closed publish eligibility`

- **Outcome:** Return structured reasons for eligibility. Check the slot, selected clip, superseded state, **the slot's bound `exportJobId` (fail closed on null — never resolve "latest export")**, pinned edit version, checksum, basic QC, editorial review, optional customer approval, pilot hold, platform connection, and the global kill switch (absorbing P0.16 as one input).
  **Customer-approval relocation — the export half is DONE (2026-08-18), do not implement it again.** The route-level export gate is already removed: `isManualExportAllowedWithoutApproval` replaces the old `APPROVAL_REQUIRED` refusal in `POST /api/clips/:id/exports`, and `isClipApprovedForPublish` / `publishApprovalBlockMessage` are the surviving publish-side authority. What remains for this commit is only the publish half: compose `isClipApprovedForPublish` into delivery eligibility (Decision D: delivery = editorial ACCEPT AND, when enabled, ClipApproval APPROVED — checked at publish time against the bound export's edit version). The earlier note that the export gate would be "retained for the customer-facing manual-export flow" no longer holds, and the P2.4 coordinator no longer needs a stated bypass of it, because there is nothing left to bypass.
- **Files:** New `src/lib/delivery/eligibility.ts`; new `src/lib/delivery/settings.ts`; new `src/lib/delivery/query.ts`; `src/lib/facebook-connection.ts`; `src/lib/env.ts`; `.env.example`; new `tests/delivery-eligibility.test.ts`; `tests/workspace-settings.test.ts`; `DECISIONS.md`.
- **Migration:** Uses Wave 1 facts. Wave 2 later supplies `ClipReview`.
- **Tests:** Full truth table; null bound export fails closed; exact export mismatch; edit mismatch; checksum mismatch; QC fail; superseded clip; blocked/unfilled/missed slot; customer approval off/on; **approval demoted after edit → ineligible even though an old SUCCEEDED export exists**; pilot hold; kill switch dominance.
- **Decision log:** One authoritative delivery rule; kill-switch precedence. The customer-approval relocation is already logged (2026-08-18); this commit records only the publish-side composition.
- **Rollback:** Keep global delivery disabled. Never fall back to "latest successful export."
- **Trace:** Rev2 §4.1 and §8; Addendum Decision D and S1.

Until P2 exists, missing editorial review is ineligible. This is intentional.

### P1.12 — Harden publication claims and reconciliation

**Commit:** `fix(publishing): bind external attempts to exact slot intent`

- **Outcome:** **Delete the latest-SUCCEEDED-export lookup** (`facebook-publisher.ts:199-205` — `exportJobs: { where: { state: "SUCCEEDED" }, orderBy: { finishedAt: "desc" }, take: 1 }`). The publisher resolves its payload exclusively through the Delivery Eligibility Module and the slot's bound `exportJobId`. Claim with scheduled-post ID, expected clip ID, expected export ID, and `NOT_STARTED` (the conditional-updateMany claim pattern already exists and is kept). Persist a `PublishAttempt` intent row before the Meta call. An indeterminate response becomes a BLOCKED slot + `EditorialException` (Wave 1) and is not blindly retried. Stale-recovery and the retry/backoff ladder are preserved but now reconcile against intent rows.
- **Files:** `src/lib/integrations/facebook-publisher.ts`; `src/lib/integrations/facebook.ts`; new `src/lib/delivery/publish-attempts.ts`; `src/worker/run-jobs.ts`; `tests/facebook-publisher-recovery.test.ts`; `tests/integration/facebook-publisher.integration.test.ts`; `tests/facebook-publisher-clamp.test.ts`; `DECISIONS.md`.
- **Migration:** Uses Wave 1 publish-attempt storage and `EditorialException`.
- **Tests:** Replacement race; exact claim; provider success; definite failure; unknown outcome → BLOCKED + exception, no blind retry; stale recovery; provider ID reconciliation; no duplicate external post; **named test: "no fallback to latest export"** (a newer SUCCEEDED export of the same clip is never selected over the bound one).
- **Decision log:** Intent-before-side-effect; no blind retry for indeterminate outcomes; the latest-export lookup is retired.
- **Rollback:** Global kill switch (P0.16). Never restore unsafe stale requeue or the latest-export query.
- **Trace:** Rev2 §§3.4 and 4.1; Addendum S1 and Decision P.

### P1 exit criteria

- Every new export pins one edit version.
- Filename changes — and midnight — do not create new work.
- Export success requires valid output with one verified checksum.
- No user, including Jake, can deliver an internal cut.
- Caption corrections survive boundary changes.
- Reanalysis cannot erase durable history.
- Scheduling uses configured weekdays, excludes Sunday, does not shift missed dates, and files `UNMATCHED` services as reserve-only.
- Retention is active in report-only mode with a verified key inventory.
- The publisher uses one fail-closed eligibility result bound to the slot's exact export, and the latest-export query is gone.
- Automatic publishing remains off until the complete controlled P2 sandbox proof publishes the exact human-accepted render successfully.


---

## 11. P2 — Human review substrate and atomic replacement (9 commits)

P2 creates trusted reference data. It does not add an agent reviewer.

### P2.1 — Deploy Migration Wave 2

**Commit:** `db(agentic-editor): add review and program substrate wave two`

- **Outcome:** Add append-only review data, unlimited feedback, operator authorization, and durable program state. Keep snapshots even if live rows disappear later. `ClipReview` includes immutable prior and replacement clip IDs/ranks/ranges plus the scheduled-post/export/edit/checksum facts needed to replay an atomic `REPLACE`. (`EditorialException` moved to Wave 1 — this wave no longer carries it.)
- **Files:** `prisma/schema.prisma`; new `prisma/migrations/<timestamp>_agentic_editor_wave_2/migration.sql`; `prisma/seed.ts`; `DECISIONS.md`.
- **Migration:** Wave 2. Add `ClipReview`; `ClipReviewFeedback`; reviewer, decision, category, severity, and actionability enums; nullable live foreign keys plus immutable snapshots; a platform-operator marker; `EditorialProgram`; and per-workspace review/cohort state needed for later explicit promotion and rollback.
- **Tests:** Clean migration; upgrade from Wave 1; delete live clip/export and preserve snapshot; multiple feedback rows; append-only constraints; enum/index/default checks; idempotent seed (match the existing mixed find-or-create/upsert seed patterns).
- **Decision log:** Append-only review truth; snapshot survival; platform staff separate from workspace ownership.
- **Rollback:** Leave the additive tables and columns. Roll application code back.
- **Trace:** Rev2 §§7–9; Addendum S5, S6, S8 (as amended), S12, S15.

Use `--create-only`, remove the two known bad tsvector statements, deploy web first, and deploy dependent worker code only after the migration succeeds.

### P2.2 — Add platform-operator authorization

**Commit:** `feat(operations): authorize Jake across pilot workspaces`

- **Outcome:** Make platform staff distinct from a church workspace owner (the repo's permission model is workspace-scoped today; `MANAGE_OPERATIONS` shows one workspace's data, not the deployment's). Add an audited operations command to grant or revoke the marker. No full staff dashboard.
- **Files:** `src/lib/authorization.ts`; `src/lib/auth.ts`; `src/lib/api/auth.ts`; new `src/lib/operator-auth.ts`; new `scripts/set-platform-operator.ts`; `package.json`; `tests/authorization.test.ts`; `tests/integration/route-authorization.integration.test.ts`; `DECISIONS.md`.
- **Migration:** Uses Wave 2 operator marker.
- **Tests:** Operator cross-workspace review access; church owner cannot gain it; viewer cannot use it; grant/revoke audit; no broad billing or destructive tenant permission implied.
- **Decision log:** Narrow platform-operator scope; script-only bootstrap.
- **Rollback:** Revoke the marker. Church operation unchanged.
- **Trace:** Product-owner requirement for Jake review; hidden staff control in Decision 1.

### P2.3 — Add append-only review and feedback services

**Commit:** `feat(review): persist exact human decisions and unlimited feedback`

- **Outcome:** Store exact review snapshots and append feedback independently without a practical limit. `ACCEPT` and `REVISE` can use the base append service. `REPLACE` is a valid vocabulary value, but a bare `REPLACE` write is forbidden: only P2.7's atomic command may create it together with supersession, reserve promotion, slot rebinding, and priority export enqueue.
- **Files:** New `src/lib/review/types.ts`; new `src/lib/review/feedback-policy.ts`; new `src/lib/review/service.ts`; new `src/lib/review/snapshots.ts`; `src/lib/analysis/reanalysis-policy.ts`; new `tests/review-policy.test.ts`; new `tests/integration/clip-review.integration.test.ts`.
- **Migration:** Uses Wave 2.
- **Tests:** Append-only decision; unlimited feedback; later feedback addition; correction by supersession; exact checksum; stale render refusal; live FK deletion; reanalysis now blocks after any review; direct bare `REPLACE` write is refused.
- **Decision log:** None beyond Wave 2.
- **Rollback:** Disable writes. Keep all collected rows.
- **Trace:** Rev2 §7; product-owner multiple-feedback rule.

Feedback actionability is table-driven (S15): `CONTENT` → replace-only; mid-clip `FORBIDDEN_CONTENT` → replace-only; `BOUNDARY` → revisable; visual crop → revisable; `CAPTION` → revisable; audio level → revisable.

### P2.4 — Automatically render only scheduled review clips

**Commit:** `feat(review): enqueue exact renders for scheduled slots`

- **Outcome:** Add one final-render eligibility rule: only the clip currently attached to a scheduled slot, or a reserve selected by the atomic replacement/fill command, can receive a final export. Apply it to both automatic and manual export paths; an unscheduled reserve remains source-preview-only. Add an idempotent coordinator used both after analysis and by a periodic reconciliation sweep. For every eligible unbound scheduled slot, enqueue a pinned default export and write its exact job id into `ScheduledPost.exportJobId`. This catches slots created while the switch was false; enabling later cannot strand them. This change removes today's accidental safety barrier: the publisher currently skips clips without a SUCCEEDED manual export, and Tier 3 never creates exports automatically. Therefore P0.16 and P1.11 must both be deployed before this commit. The coordinator and sweep require `AUTOMATIC_PUBLISHING_ENABLED=true`; while the switch is false they record no export work. Prepare the sandbox proof with one explicit manual exact render of a scheduled clip. After that render passes QC, exact human acceptance, and every eligibility input except the switch, temporarily enable the switch for the controlled sandbox call. Automatic review rendering begins only after that call succeeds. Unapproved scheduled renders remain publication-ineligible through P1.11/P2.8. Note that manual editor export is no longer gated on approval (2026-08-18), so P2.4's rule that "only a scheduled or reserve-selected clip can receive a final export" is now the only export-side eligibility rule — it must be applied on its own merits, not as a companion to an approval gate that no longer exists.
- **Files:** New `src/lib/review/final-render-eligibility.ts`; new `src/lib/review/render-coordinator.ts`; `src/lib/jobs/handlers/analyze.ts`; `src/worker/run-jobs.ts`; `src/lib/exports/queue.ts`; `src/app/api/clips/[id]/exports/route.ts`; `src/lib/env.ts`; `docs/DEPLOYMENT.md`; `tests/review-render-coordinator.test.ts`; worker-isolation test; `tests/integration/route-authorization.integration.test.ts`; `tests/integration/analyze-job.integration.test.ts`; `tests/integration/phase-6-7-workflow.integration.test.ts`.
- **Migration:** Uses Wave 1 `editVersion` and `ScheduledPost.exportJobId`.
- **Tests:** Switch false or missing → analysis caller and reconciliation sweep enqueue nothing and write no binding; scheduled clip can still use the explicit manual sandbox-render path; manual or automatic export of an unscheduled reserve is refused; switch true + one service → six; switch true + two-service project → three; a pre-existing eligible unbound slot is caught after enablement exactly once; reserve ranks enqueue none; thin pool; blocked/unfilled/missed slot skipped; retry/concurrent sweep idempotency; exact version 0 or latest explicit version; `exportJobId` written; one failing sweep item does not block later items; unapproved-but-scheduled clip can render after enablement but remains publish-ineligible.
- **Decision log:** Final MP4 files are created only for scheduled or promoted clips.
- **Rollback:** Disable coordinator enqueue. Manual export remains available.
- **Trace:** Rev2 §2.4, §7.1, Decision N; cost architecture; P1.11 approval relocation.

### P2.5 — Add the exact-render operator review queue

**Commit:** `feat(review-ui): let staff review the actual deliverable file`

- **Outcome:** Add a cross-workspace operator queue and a detail page that plays the exact final MP4 (via the slot's bound export). Show title and hook as machine-generated fields under review. Hide selector score, subscores, and rationale (S14). **Signed-URL scoping:** `createSignedMediaUrl` is workspace-scoped HMAC — the operator pages must mint URLs scoped to the *target church's* workspace after the operator-authorization check, not the operator's own.
- **Files:** New `src/lib/review/query.ts`; new `src/app/app/operator/review/page.tsx`; new `src/app/app/operator/review/[scheduledPostId]/page.tsx`; new `src/components/operator/rendered-clip-review.tsx`; `src/components/app-shell.tsx` (nav item + operator permission slug); `src/lib/media/signed-url.ts`; read-model unit tests; new `tests/e2e/operator-review.spec.ts`.
- **Migration:** Uses Wave 2.
- **Tests:** Operator access; church denial; exact signed file for the bound export; checksum/edit/export identity; stale selection; selector information absent; title/hook visible; QC result visible; cross-workspace URL scoping.
- **Decision log:** None.
- **Rollback:** Remove operator navigation and pages. Review storage remains.
- **Trace:** Rev2 §§7.1, 9, 14; Addendum S14.

Before this UI edit, read the relevant bundled Next 16 routing, server-component, authorization, and data-fetching guides.

### P2.6 — Add accept, revise, and multiple-feedback UI

**Commit:** `feat(review-ui): support accept revise and extra feedback`

- **Outcome:** Let Jake submit `ACCEPT` or `REVISE` with several findings, then add more findings later. `REVISE` blocks delivery until a new exact render is accepted. Show the `REPLACE` control as unavailable until P2.7 lands; never create a partial replacement decision.
- **Files:** New `src/app/actions/clip-review.ts`; `src/components/operator/rendered-clip-review.tsx`; new `src/components/operator/review-feedback-list.tsx`; `src/app/app/operator/review/[scheduledPostId]/page.tsx`; `src/lib/review/service.ts`; `tests/integration/clip-review.integration.test.ts`; `tests/e2e/operator-review.spec.ts`.
- **Migration:** Uses Wave 2.
- **Tests:** Accept; revise; several initial feedback items; append later; category/actionability; invalid revise for replace-only defect; stale action; revision requires new pinned export; partial replace cannot be submitted.
- **Decision log:** The three-decision vocabulary if not already in P0.2.
- **Rollback:** Disable actions. Existing evidence remains readable.
- **Trace:** Rev2 §§2.6, 6, 7; product-owner decision vocabulary.

Before this UI edit, read the relevant bundled Next 16 server-action and form guides.

### P2.7 — Make replacement one atomic transaction

**Commit:** `feat(review): atomically replace a scheduled clip with its next reserve`

- **Outcome:** Move same-project reserve selection and priority export behavior into P2. In one database transaction: conditionally claim the exact expected `ScheduledPost` only from an allowed pre-publish state; refuse `MISSED`, `IN_PROGRESS`, and `SUCCEEDED`; verify the exact current clip/export/edit/checksum; select the lowest-rank eligible unused candidate from the same project; append the human `REPLACE` review and all initial feedback; mark the old clip `SUPERSEDED` for the complete project; create or reuse a pinned priority `ExportJob` for the reserve; bind the slot's `clipId` and `exportJobId` to that exact job; return its publish state to `NOT_STARTED` while preserving scheduled date and platform; and extend retention when required. Change `enqueueExportJob` to accept a Prisma transaction client so job creation is part of the same commit. Change export claiming to `priority desc, createdAt asc`. If no reserve exists, the same transaction still records `REPLACE` and supersedes the rejected clip, clears the slot's rejected clip/export binding, sets it to `UNFILLED` (or `BLOCKED` for a non-shortage failure), creates an `EditorialException`, and notifies after commit. `ScheduledPost.projectId` preserves ownership. Two concurrent replacements cannot select the same reserve. Enable the `REPLACE` UI only with this command.
- **Files:** New `src/lib/review/reserve-policy.ts`; new `src/lib/review/replace-scheduled-clip.ts`; `src/lib/review/service.ts`; `src/lib/exports/queue.ts`; `src/app/actions/clip-review.ts`; `src/components/operator/rendered-clip-review.tsx`; `src/lib/retention.ts`; new `tests/reserve-policy.test.ts`; new `tests/integration/replace-scheduled-clip.integration.test.ts`; `tests/integration/clip-review.integration.test.ts`; `tests/e2e/operator-review.spec.ts`; `DECISIONS.md`.
- **Migration:** Uses Wave 1 superseded state, priority, exact slot binding, schedule states, and `EditorialException`; uses Wave 2 review tables. No new migration.
- **Tests:** Rank order; scheduled/superseded/hidden/forbidden/different-project exclusion; exact expected-slot guard; `MISSED`/`IN_PROGRESS`/`SUCCEEDED` refusal; one atomic success; date/platform preserved; state returns to `NOT_STARTED`; append-only decision and several feedback rows; old clip superseded project-wide; exact new binding; priority claim wins over older normal work; idempotent retry; two concurrent replacements promote only one reserve; no reserve supersedes the rejected clip, clears both bindings, preserves project ownership, and creates one visible `UNFILLED` exception; transaction rollback leaves the old clip and binding unchanged; notification failure cannot roll back committed state.
- **Decision log:** Replacement is one transaction; no backup-to-primary mapping; same-project reserve only; priority affects claim order.
- **Rollback:** Disable `REPLACE` and retain all append-only evidence. Do not restore a multi-step replacement path.
- **Trace:** Rev2 §6; Addendum Decisions J, L, and P; Jake's final plan-correction answer.

Before this UI edit, read the relevant bundled Next 16 server-action and form guides.

### P2.8 — Require exact editorial acceptance for delivery

**Commit:** `feat(delivery): require human acceptance of the exact render`

- **Outcome:** Make P1.11's Delivery Eligibility Module query the latest applicable `ACCEPT`. Require an exact clip, edit version, export (the slot's bound `exportJobId`), and checksum match. If customer approval is enabled, require it too.
- **Files:** `src/lib/delivery/query.ts`; `src/lib/delivery/eligibility.ts`; `src/lib/integrations/facebook-publisher.ts`; `src/app/api/exports/[id]/retry/route.ts`; `tests/delivery-eligibility.test.ts`; `tests/integration/facebook-publisher.integration.test.ts`; `tests/integration/clip-review.integration.test.ts`; `DECISIONS.md`.
- **Migration:** Uses Wave 2.
- **Tests:** Accepted exact file; newer edit; rerender; revised clip; replaced clip; selected clip changed; customer approval disabled/enabled; human-only phase; legacy export.
- **Decision log:** Only the exact accepted checksum can publish.
- **Rollback:** Turn global delivery off. Never turn the review requirement off.
- **Trace:** Rev2 §§4.1 and 8; Addendum Decision D.

### P2.9 — Start the fixed 30-day human-only program explicitly

**Commit:** `feat(review-program): activate audited human-only collection`

- **Outcome:** Add an explicit start command and status report. The clock starts only after an end-to-end smoke test proves exact playback, review writes, basic QC, delivery gating, one atomic P2.7 replacement, and the P2 sandbox publication sequence. The sandbox sequence is: keep the global switch false; create one manual pinned render; record an exact human `ACCEPT`; query Delivery Eligibility and prove that exactly one intended sandbox row has `PUBLISHING_DISABLED` as its only failing reason; prove that every other due row has at least one additional failing reason or is disabled or held; use a dry run that simulates only the global switch as true and prove that its eligible-post census contains exactly the intended sandbox row; temporarily enable the switch; publish to the real sandbox Page; verify the exact accepted export and provider result; then leave publishing enabled only if the complete eligibility path passed. If the dry-run census is not exactly the intended sandbox row, do not enable. P3 is not a prerequisite. The human-reference phase lasts at least 30 full calendar days.
- **Files:** New `src/lib/review/editorial-program.ts`; new `scripts/start-editorial-program.ts`; new `scripts/editorial-program-status.ts`; `src/lib/delivery/eligibility.ts`; `src/app/app/operator/review/page.tsx`; `package.json`; new `tests/editorial-program.test.ts`; review integration/E2E tests; new `docs/HUMAN_REVIEW_30_DAY_RUNBOOK.md`; `DECISIONS.md`.
- **Migration:** Uses Wave 2 program state.
- **Tests:** Explicit start; cannot backdate; zero, one, and multiple switch-only-failure census results; intended sandbox row with another failure blocks the proof; any non-sandbox switch-only-failure row blocks the proof; start refused without exact-render, atomic-replacement, and sandbox-publication evidence; day 29 held; day 30 remains human-authoritative until P7 is deployed and explicitly changed; no agent rows; pause extends rather than shortens; review time and decision metrics.
- **Decision log:** Supersede Addendum S17's compression permission. Record the fixed full 30 days and the clock-start preconditions.
- **Rollback:** Pause the program and delivery. Do not shorten or erase elapsed history.
- **Trace:** Rev2 §9; product-owner Decision 2; deployment steps 18–19.

Before this UI edit, read the relevant bundled Next 16 guide.

### P2 exit criteria

- Jake has narrow, audited cross-workspace access.
- Scheduled clips render automatically with the slot↔export binding written. Reserves do not render.
- Jake can play the exact final file, choose `ACCEPT`/`REVISE`/`REPLACE`, and add any number of feedback items over time.
- Old acceptance is invalid after any material change.
- Church approval composes correctly when enabled — at publish time, against the bound export.
- Gate C passes.
- `REPLACE` is one P2 transaction and cannot strand a slot through a partial write.
- The human-only program starts through one explicit recorded action after Gate C and the exact P2 sandbox proof. P3 is not a prerequisite.

---

## 12. P3 — Candidate and operator experience (9 commits)

P0 supplies internal candidate controls. P2 supplies exact review, same-project atomic replacement, priority rendering, and empty-reserve exceptions. P3 makes those facts understandable and adds explicit operator-only recovery tools. It does not gate the human-reference clock and adds no migration.

### P3.1 — Define one role-safe candidate-pool read model

**Commit:** `feat(candidates): derive service pool presentation states`

- **Outcome:** Add one server-side query and pure classifier for a service project. Preserve original rank. Derive `SCHEDULED`, `SELECTED_REPLACEMENT`, `PRIOR_SERVICE_FILL`, `RESERVE`, `SUPERSEDED`, and `HIDDEN` from clips, slots, review history, and the slot's owning-project relation. `PRIOR_SERVICE_FILL` is a presentation-only state for a slot whose selected clip belongs to an older project; it must not be mislabeled as a same-project `REPLACE`. Include actual retained count, title, hook, source range, duration, scheduled date, review state, exact bound-render state, and render-source availability. Sort the reserve queue by original rank. Include a candidate explicitly borrowed from an older project through the slot relation. Do not persist backup mappings. Return role-specific shapes: church responses omit master default, hard maximum, effective snapshot, hidden override, selector scores, subscores, model version, excerpt, and rationale.
- **Files:** New `src/lib/candidates/project-pool.ts`; new `src/lib/candidates/query.ts`; new `tests/candidate-pool.test.ts`; new `tests/integration/candidate-pool-query.integration.test.ts`.
- **Migration:** None. Uses Wave 1 `ScheduledPost.projectId` and Wave 2 review data.
- **Tests:** One-service pool; two-service pool; thin pool; selected replacement; borrowed prior-service candidate is `PRIOR_SERVICE_FILL`, not `SELECTED_REPLACEMENT`; superseded and hidden exclusion from reserve; rank stability; unfilled slot with no clip; one ordered reserve queue; render source present/purged; settings edit does not change the project snapshot; church shape contains no internal limit or Selector facts.
- **Decision log:** None.
- **Rollback:** No production caller yet.
- **Trace:** Rev2 §§2.4, 5, 6, and 7; Addendum Decisions J and L; S9 and S14.

### P3.2 — Show the complete actual pool to church users

**Commit:** `feat(projects): show the complete ranked candidate pool`

- **Outcome:** Improve the existing project page. Show the number of candidates that actually exist, not the configured ceiling. Show rank, title, hook, duration, source range, scheduled date, candidate state, review state, and final-render state. Keep current edit and approval actions. Clearly label reserves as source-preview candidates with no final render. A thin pool is valid and is not called a processing failure.
- **Files:** `src/app/app/projects/[id]/page.tsx`; `src/components/clip-list.tsx`; new `src/components/candidates/candidate-state-badge.tsx`; `src/app/api/projects/[id]/clips/route.ts`; new `tests/e2e/project-candidate-pool.spec.ts`; `tests/integration/route-authorization.integration.test.ts`.
- **Migration:** None.
- **Tests:** Actual count visible; scheduled and reserve sections correct; replacement preserves original rank; prior-service fill is labeled distinctly; superseded clip visible as retired; API and rendered HTML contain no master default, maximum, hidden override, effective ceiling, Selector score, subscores, model version, excerpt, or rationale.
- **Decision log:** None.
- **Rollback:** Restore the current flat clip list.
- **Trace:** Rev2 §7 and §13 P3; product-owner Decision 1.

Church copy can say, for example, `12 ranked clips`. It must not say `up to 18` or expose any configured limit.

Before this UI edit, read the relevant bundled Next 16 routing, server-component, data-fetching, and component guides.

### P3.3 — Add the cross-workspace operator project view

**Commit:** `feat(operations): inspect service candidate pools`

- **Outcome:** Let an authorized platform operator open a service from the P2 review queue and inspect its complete candidate pool, posting slots, replacement lineage, and open or resolved exceptions. Use the target church's workspace for signed media. Do not grant billing, workspace-settings, publishing, or membership authority.
- **Files:** `src/lib/candidates/query.ts`; `src/lib/review/query.ts`; new `src/app/app/operator/projects/[projectId]/page.tsx`; new `src/components/operator/project-candidate-pool.tsx`; new `src/components/operator/editorial-exception-list.tsx`; P2 review queue/detail links; operator E2E tests.
- **Migration:** None.
- **Tests:** Operator cross-workspace access; church-user denial; target-workspace media signing; all actual candidates shown; replacement lineage; open/resolved exceptions; no candidate-limit editor; pending review does not expose Selector scores, subscores, or rationale.
- **Decision log:** None.
- **Rollback:** Remove the operator page and links. P2 review remains operational.
- **Trace:** Rev2 §§7 and 9; Addendum S14.

Before this UI edit, read the relevant bundled Next 16 routing, authorization, server-component, and data-fetching guides.

### P3.4 — Add cheap on-demand candidate previews

**Commit:** `feat(candidates): preview retained source ranges on demand`

- **Outcome:** Add one-at-a-time source-range playback for retained candidates. Use the existing byte-range signed-media route with `preload="none"`. Never create an `ExportJob` or final MP4 for preview. Clamp playback to the candidate's one continuous start/end range. If retention already purged the renderable source, show a clear unavailable state and do not create a broken signed URL. P4 later switches the media source to the shared uncropped 480p proxy without changing this UI contract.
- **Files:** New `src/components/candidates/source-range-preview.tsx`; church and operator candidate components; signed-media tests; new component/E2E tests.
- **Migration:** None.
- **Tests:** No autoplay; no eager download for all candidates; one preview opens on demand; playback stops at the continuous end; no internal skips; preview creates no export job; purged source shows unavailable without signing; target-workspace authorization.
- **Decision log:** None.
- **Rollback:** Remove inline playback and retain metadata/editor links.
- **Trace:** Rev2 §7; Decision N; derivative-first principle.

Before this UI edit, read the relevant bundled Next 16 client-component and media guides.

### P3.5 — Define explicit prior-service fill eligibility

**Commit:** `feat(reserve): define operator prior-service fill policy`

- **Outcome:** Add a pure policy for the optional shortage workflow. The operator must select one exact candidate. The system never selects or borrows across projects automatically. Eligibility requires: same workspace; older READY project; candidate not attached to any scheduled-post row; not superseded, hidden, or known forbidden; a non-null renderable source key on `SourceVideo` before P4, or a registered renderable `DerivedMediaArtifact` after P4; target slot `BLOCKED` or `UNFILLED`; no publish claim; and a posting date that has not passed. Extending retention is not a substitute for this check because it cannot restore deleted media.
- **Files:** New `src/lib/review/prior-service-fill-policy.ts`; new `tests/prior-service-fill-policy.test.ts`.
- **Migration:** None.
- **Tests:** Same-workspace older project; current/newer/different-workspace refusal; hidden, superseded, any historical scheduled-post attachment, and forbidden refusal; retained source accepted; expired or purged source refused; publishing/published/missed refusal; exact operator selection; no automatic fallback.
- **Decision log:** None.
- **Rollback:** No caller yet.
- **Trace:** Rev2 §5.2; Addendum Decision J.

### P3.6 — Apply an explicit prior-service fill atomically

**Commit:** `feat(reserve): bind an operator-selected prior-service candidate`

- **Outcome:** In one transaction, take the same `SourceVideo` row lock introduced in P1.9, recheck the source key and all durable purge facts, extend retention, confirm the exact target slot state and identity, confirm the selected candidate remains eligible, attach it, create or reuse its pinned priority export, bind `ScheduledPost.exportJobId`, return the slot to `NOT_STARTED`, preserve its owning service `projectId`, date, and platform, resolve the matching exception, and record an audited operational event with both the target project ID and source project ID. The row lock serializes this command with source cleanup: if cleanup won, the now-null source key refuses the fill; if fill won, cleanup must re-read the extended expiration and keep the source. Do not create a second `REPLACE` decision. The earlier decision or shortage evidence remains unchanged. Delivery remains blocked until Jake accepts the new exact render. If storage materialization still fails after commit, the export fails visibly and delivery stays blocked; the system does not select another candidate automatically.
- **Files:** New `src/lib/review/prior-service-fill.ts`; P2 render coordinator/priority helper; `src/lib/retention.ts`; operational-event helper; new `tests/integration/prior-service-fill.integration.test.ts`; `DECISIONS.md`.
- **Migration:** None.
- **Tests:** Exact conditional claim; same-candidate and same-slot races; stale form; tenant refusal; published refusal; cleanup-wins race sees the null key and refuses; fill-wins race extends retention and cleanup preserves the source; priority render; pinned version and exact binding; owning project/date/platform preserved; target and source project IDs audited; retention extension; exception resolution without deletion; idempotent retry; post-commit storage failure stays blocked and never auto-selects another candidate; exact new acceptance required.
- **Decision log:** Cross-project filling is platform-operator initiated only. It never runs as an automatic reserve fallback.
- **Rollback:** Remove callers. Already filled slots remain valid scheduled slots.
- **Trace:** Rev2 §5.2; Decisions J, N, and P; S6b.

### P3.7 — Add the operator shortage-resolution action

**Commit:** `feat(operations): resolve unfilled slots with prior candidates`

- **Outcome:** On an open `BLOCKED` or `UNFILLED` exception, show eligible older projects and candidates. Require the operator to choose and confirm one candidate. Do not preselect one. After success, show the slot with its priority render in progress. Link it into the exact-render review queue only after that export succeeds and the bound checksum exists.
- **Files:** New `src/app/actions/operator-prior-service-fill.ts`; new `src/components/operator/prior-service-fill-form.tsx`; operator project and review pages; calendar exception link; E2E tests.
- **Migration:** None.
- **Tests:** Operator-only action; church denial; empty list; explicit confirmation; stale conflict; successful fill; pending render does not open a nonexistent exact file; successful export enters exact-render review; failed export stays visible and blocked; no automatic request on page load; no church-facing fill control.
- **Decision log:** None beyond P3.6.
- **Rollback:** Remove the action and form. Exceptions remain visible for manual handling.
- **Trace:** Rev2 §§5.2 and 7; Decision J.

Before this UI edit, read the relevant bundled Next 16 server-action, form, authorization, and routing guides.

### P3.8 — Let an operator reschedule a missed slot explicitly

**Commit:** `feat(operations): reschedule missed posts without shifting the week`

- **Outcome:** Add a separate audited operator action for a `MISSED` slot. Require an explicit future non-Sunday church-local date. Mutate the same row to the new date and `NOT_STARTED`; never let automation shift it and never insert a second row for the same unique clip. Preserve exact clip/export binding when still valid, keep delivery eligibility authoritative, reset only retry/error facts appropriate to the new attempt, extend retention, and resolve the matching missed-date exception after success.
- **Files:** New `src/lib/schedule/reschedule-missed.ts`; new `src/app/actions/operator-reschedule-missed.ts`; operator exception/calendar UI; `src/lib/retention.ts`; new unit, integration, and E2E tests; `DECISIONS.md`.
- **Migration:** None. Uses the Wave 1 non-`MISSED` date constraint.
- **Tests:** Operator only; future non-Sunday date; past/Sunday refusal; non-MISSED refusal; workspace/date collision refusal; same-row mutation; no duplicate `clipId`; exact binding retained or fails closed; retention extension; exception resolution; no automatic call path.
- **Decision log:** `MISSED` is terminal for automation. Only an explicit operator action can reschedule it.
- **Rollback:** Remove the action. Existing rescheduled rows remain normal slots.
- **Trace:** Addendum Decision O; one-non-`MISSED` database rule.

Before this UI edit, read the relevant bundled Next 16 server-action, form, and timezone-related guides.

### P3.9 — Show the unsupported third-service option correctly

**Commit:** `feat(onboarding): mark three weekly services as coming later`

- **Outcome:** Add a disabled `3 services — Coming later` option in onboarding and settings. Keep `SermonsPerWeek = 1 | 2` and both server validation schemas restricted to 1 or 2. Add helper text that service-setting changes affect only projects created afterward. Remove any claim that church settings control how many candidates are generated.
- **Files:** `src/app/onboarding/page.tsx`; `src/app/app/settings/page.tsx`; onboarding/settings E2E tests; action-validation tests.
- **Migration:** None.
- **Tests:** Option visible and disabled; forged value 3 rejected server-side; one and two still save; existing project snapshot unchanged; no candidate limit appears in church settings or response data.
- **Decision log:** None.
- **Rollback:** Remove the disabled option while retaining server rejection.
- **Trace:** Rev2 §2.2 and §4; Addendum S9; product-owner Decision 1.

Before this UI edit, read the relevant bundled Next 16 form, server-action, and component guides.

### P3 exit criteria

- Church users see every actual retained candidate but no internal candidate limit.
- Jake can inspect the same service pool across workspaces.
- One project has one rank-ordered reserve queue and no per-primary backup mapping.
- Candidate ranks never change; thin pools stay thin.
- Settings changes affect only new projects.
- Reserves use on-demand source previews and receive no final MP4 before selection.
- P2 replacement lineage and reserve-exhaustion exceptions are visible.
- Prior-service filling requires one explicit operator selection and never runs automatically.
- Prior-service filling requires retained renderable source media and distinguishes a prior-service fill from a same-service replacement.
- A missed slot moves only through an explicit operator action, never automatic shifting.
- Three services is visible but disabled and remains invalid on the server.
- P3 adds no migration and does not gate the 30-day human-reference clock.

### P3 main risks

- Role-shaped responses leak internal limits or Selector rationale.
- Source previews eagerly download too much media.
- A borrowed candidate loses the target service's project identity.
- A prior-service fill is offered after its source media has already been purged.
- Prior-service fill or missed reschedule races with publishing.
- A resolved exception is deleted instead of retained as evidence.
- A thin pool is misreported as a processing failure.

---

## 13. P4 — Derivative-first sermon understanding and Media Region Index

**Planning status for P4–P8:** The first-commit sketches, objectives, gates, and risks below are binding direction, but they are not a frozen commit count. After P0 and P2 produce measured cost, quality, failure, and review data, write and approve a measured commit-by-commit update for P4–P8 before their behavior is implemented. Do not preselect exact models, thresholds, or vendors without that evidence.

### Objective

Create one reusable, low-cost representation of the complete service. Use cheap local evidence to select one conservative sermon corridor before any paid transcription. Send only that corridor to Scribe, then use the precise transcript for forbidden detection, candidate playback, and on-demand visual evidence.

### Sermon-boundary detection is two passes

**Pass A, before Scribe (cheap and local).** Source metadata, audio classification, scene
evidence, and short local whisper.cpp samples at ambiguous edges select ONE conservative
continuous sermon corridor. Only that corridor is sent to Scribe, in one request.

**Pass B, after Scribe (precise).** Scribe's transcript, diarization, and audio events classify
the precise forbidden regions inside and around the corridor — worship, announcements, prayer,
baptism, altar call, verse slideshows.

Pass A is a cost-control boundary, not the safety decision; Pass B is where forbidden regions
become precise. A boundary that stays ambiguous after Pass A raises a human exception. There is
never a silent full-service Scribe fallback.

The provider that serves production captions is named explicitly by
`TRANSCRIPTION_PRIMARY_PROVIDER` / `TRANSCRIPTION_FALLBACK_PROVIDER`, never inferred from which
credential is present (see the 2026-08-16 provider-selection decision). whisper.cpp's Pass A role
does not make it the production caption provider, and holding an ElevenLabs key does not make
Scribe the production caption provider.

Since the 2026-08-19 decision the active pair is `scribe` primary, `whisper_cpp` secondary, in
every environment. Pass A is therefore an efficiency improvement rather than an activation gate:
Scribe is already serving, on the narrowest range currently known, which is usually the complete
service. Building Pass A narrows what is paid for; it does not unblock anything.

### Recommended evidence pipeline

```text
temporary original materialization
→ original probe facts and free source metadata hints
→ 16 kHz mono FLAC analysis audio and uncropped 480p H.264 source proxy
→ FFmpeg scene changes, black/freeze/motion facts
→ sparse WebP frames and perceptual hashes
→ person/face inference on cluster representatives
→ OCR only on likely static text frames
→ local speech, music, and audio-event corroboration when needed
→ coarse source regions and one conservative continuous sermon corridor
→ short local-ASR checks only at ambiguous corridor boundaries
→ one paid visual escalation for unresolved boundary ambiguity
→ still ambiguous: human exception; never a silent full-service Scribe fallback
→ sermon-only 16 kHz mono FLAC with the exact source-time offset
→ one base Scribe v2 request with no-verbatim disabled
→ deterministic silences, sentences, and paragraphs
→ transcript classification and precise forbidden-region refinement
→ MediaRegion rows keyed by SourceVideo
```

### Recommended metadata

The transcript representation must include: every word and timestamp; the exact offset back to source time; the submitted audio duration and checksum; the provider request or transcription id; word confidence when supplied (whisper.cpp already yields per-token probabilities — note these are sub-word tokens, not words); speaker label; audio-event label and interval; silence interval; sentence boundary; paragraph boundary; source provider and model version; capability status (native, derived, unavailable, user-supplied); provenance for every derived field.

The Media Region Index can contain overlapping facts: `SERMON`, `WORSHIP`, `ANNOUNCEMENT`, `PRAYER`, `BAPTISM`, `ALTAR_CALL`, `OTHER_SERVICE_CONTENT`, `PASTOR_VISIBLE`, `FULLSCREEN_SLIDE`, `VERSE_SLIDESHOW`, `AMBIGUOUS`.

Detector facts are not editorial policy. Store the facts and detector confidence. Keep allow, avoid, forbid, and salvage rules in versioned code.

The pre-Scribe corridor is a cost-control boundary, not the final safety decision. Use one continuous request instead of one request per clip or fragment. After Scribe returns, refine all forbidden regions from its word-level transcript, diarization, and audio events. Worship, announcements, baptisms, prayers, verse slideshows, and altar calls remain forbidden for clip selection and export. If useful sermon speech continues over a verse slideshow, retain that audio in the transcript for future text features, but mark the visual interval as ineligible for video clips.

### Milestone work

1. Deploy Wave 3 for `MediaRegion` and `DerivedMediaArtifact`, keyed by `sourceVideoId` (S18-i: regions describe source media, survive reanalysis, and are reusable across projects sharing a source).
2. Add transcript capabilities and provenance in the same wave.
3. Confirm production uses R2-class free-egress storage — the *check* already happened at Gate A (P0.19); this step executes any bucket migration it surfaced.
4. Add a `CachedStorageProvider` at the single `getStorageProvider()` factory (content identity, LRU-by-bytes eviction, concurrent dedup, copy/hardlink into the caller's destination because all four materialization call sites `rm -rf` their temp dirs).
5. Add one source lease so a project batch uses one materialization.
6. Change PROBE into one coordinated derivative build.
7. Keep original width and height authoritative. **Never write proxy dimensions into `SourceVideo.width/height`** — those columns drive the export crop rect (S13b); note they are nullable and export already hard-fails on null.
8. Add scene, silence, black-frame, freeze, motion, waveform, and frame-hash facts.
9. Evaluate commercially safe local person/face, OCR, speech/music, and audio-event models before adding their weights (license check per CTO.md; weights via `/models` volume + SHA-256, never baked into the image).
10. Run expensive local inference only on sparse cluster representatives.
11. Build coarse source-level regions from free metadata hints and local audio/visual facts. Select one conservative continuous sermon corridor with configurable handles.
12. Use short local whisper.cpp windows only when a corridor boundary remains ambiguous. This is whisper.cpp's second role — a cheap local boundary sampler — and it is separate from whichever provider `TRANSCRIPTION_PRIMARY_PROVIDER` names for production captions. Permit one paid visual escalation per ambiguous service within budget (S16). Still ambiguous → human exception; no background retry and no silent full-service Scribe fallback.
13. Extract one sermon-only 16 kHz mono FLAC. Store its exact source-time offset, duration, checksum, detector version, and corridor confidence.
14. Change the production Scribe path to submit that single sermon-only artifact. Keep base Scribe v2, `no_verbatim=false`, no keyterms by default, word timestamps, diarization, and audio events. Preserve the completed whisper.cpp-versus-Scribe benchmark as the provider decision evidence. **This step does not gate Scribe activation** (2026-08-19 decision — Scribe is already active): it is a cost and processing efficiency improvement. Until it lands, transcription submits the narrowest sermon range already known and records `submittedDurationS` and `submittedScope`, so what the missing stage costs stays measured.
15. Derive deterministic silences, sentences, and paragraphs. Use the Scribe result to refine precise `SERMON`, `WORSHIP`, `ANNOUNCEMENT`, `PRAYER`, `BAPTISM`, `ALTAR_CALL`, and other service-content regions in source time.
16. Persist source-level regions and detector versions. `FULLSCREEN_SLIDE` regions carry a subtype: `SCRIPTURE`, `SERMON_TITLE`, `MAIN_POINT`, `SUBPOINT`, `NUMBERED_POINT`, `SECTION_TRANSITION`, or `OTHER_PRESENTATION`, plus confidence and OCR evidence. Consecutive scripture slides also form a `VERSE_SLIDESHOW` region. This lets final QC report and test each forbidden slide class instead of collapsing all slides into one label.
17. Implement `timeline_view` and `boundary_strip` from the shared 480p proxy. Register the proxy's storage key in retention/DerivedMediaArtifact (S13a — an unregistered key leaks forever; the P1.9 four-key inventory work is the cautionary precedent).
18. Apply boundary salvage: move a start after a short edge slide or an end before it. Reject a necessary mid-clip slide.
19. Add direct browser-to-R2 multipart upload for the S3 provider. Keep the current relay only for local storage or explicit fallback.
20. Prove PERC recording retrieval and deletion as a separate intake experiment (zero PERC code exists today).
21. Create keyframe-padded original-quality range derivatives for every retained candidate while the source is local. Merge overlaps; configurable handles.
22. Verify every range derivative by checksum, duration, range coverage, source dimensions, and visual-quality comparison. Prefer stream copy when safe; otherwise a visually lossless mezzanine.
23. After range-derivative proof passes, delete the large original earlier than `last scheduled date + 14 days`. Until then, keep that date as the conservative fallback.
24. Render final scheduled/promoted clips from range derivatives. A full-source fallback is explicit, metered, and exception-visible.
25. Register every artifact, byte count, retention class, and cleanup path.

### First P4 commit sketch

**Commit:** `db(media-index): add source regions and derived artifacts`

- **Outcome:** Additive storage for source-level detection facts and all new derivatives. No worker uses it until the web migration is live.
- **Files:** `prisma/schema.prisma`; new Wave 3 migration; new `src/lib/media-regions/types.ts`; new `src/lib/media-artifacts/types.ts`; new persistence integration tests.
- **Migration:** Wave 3. Generate with `--create-only`; remove the two known invalid tsvector statements.
- **Tests:** Clean migration; Wave 2 upgrade; source-keyed region; artifact checksum/byte count/retention class; deletion behavior; duplicate detector version identity.
- **Decision log:** Source-level ownership; artifact registry as the cleanup authority (superseding the hard-coded four-key lists).
- **Rollback:** Leave unused tables in place and roll worker code back.
- **Trace:** Rev2 §§4.4–4.7, 11, 13 P4; Addendum S2, S3, S6, S7, S13, S16, S18; product-owner media principle.

### P4 acceptance gates

- One remote source acquisition creates all normal derivatives.
- Transcript analysis does not read video pixels.
- Paid transcription receives one sermon-only corridor during the normal path, never the complete service.
- Every cropped transcript maps back to source time by a stored, tested offset.
- The normal path never silently falls back to full-service Scribe or many per-clip Scribe requests.
- Candidate playback uses one uncropped 480p proxy.
- No reserve candidate receives a separate final MP4.
- Proxy dimensions never modify original source dimensions.
- Every artifact has checksum, byte count, derivation version, retention class, and a tested deletion path.
- Media regions survive project reanalysis.
- Full-screen-slide recall is published per detector version; expected initial autonomy target ≥90% of labeled slide-seconds (S18).
- Known worship, announcement, baptism, prayer, altar-call, and verse-slideshow overlap in deliverable candidates is zero.
- Useful sermon speech over a forbidden visual interval remains available for text features but is not video-eligible.
- One unresolved escalation creates an exception.
- Normal final rendering reads candidate-range media, not the full service.
- The range path has no material visual loss versus the original.
- Direct upload does not relay source bytes through the web service in production.

### P4 main risks

- The full-source fallback silently becomes normal.
- Range seeking is unreliable for some MP4 layouts.
- Candidate handles are too small for Jake's boundary change.
- Temporary disk fills under concurrent services.
- An artifact leaks because cleanup does not know it.
- A face printed on a slide is mistaken for a live pastor.
- A local model license is not suitable for a commercial SaaS.
- Scribe quality does not beat the current provider on real church audio.
- A coarse boundary cuts valid sermon speech before Scribe can classify it.
- A wrong source-time offset misaligns every caption and region after the crop.
- Many small corridor requests replace the intended single Scribe request and erase the cost savings.
- Paid boundary escalation costs more than the Scribe audio it was meant to save.

P0 telemetry must decide proxy bitrate, FLAC settings, sparse-frame cadence, scene threshold, cache size, candidate handles, range-mezzanine format, and exact local models.

---

## 14–15. P5 Selector policy and P6 Review Agent design — WITHHELD

These two sections are not published in this repository copy.

They specify the editorial ranking criteria, the evidence pipeline, the revise-versus-replace
policy, and the prompt design that together form Pulpit Engine's proprietary editorial logic.
That material is the reason the repository becomes private at the start of P5 (see the
2026-08-11 decision entry "Repository Stays Public Until P5"). Publishing the design here while
the repository is public would defeat the trigger, because public git history cannot be retracted.

The full sections live with the private planning copy in the operator's workspace. They are added
to this document by a follow-up commit once the repository is private.

What is public and unchanged: the editorial invariants every phase must honor are in
`docs/PULPIT_ENGINE_EDITORIAL_STANDARD.md`, and the P0–P4 implementation detail is below.

## 16. P7 — Fixed 30/30/30 transition and evidence-gated autonomy

### Operating modes

`HUMAN_REFERENCE`, `BLIND_SHADOW`, `AGENT_FIRST_HELD`, `AUTONOMOUS`, `KILL_SWITCHED`. Time never promotes a policy by itself. Jake performs an explicit promotion after the relevant evidence gate passes.

### Days 1–30

Full 30 calendar days. Jake watches every scheduled final render, decides first and alone; the agent does not influence the decision. Store review time, decision, all feedback, edits, replacements, cost, and latency.

### Blind-shadow phase (earliest days 31–60)

Run no fewer than 30 complete blind-shadow calendar days. Jake and agent review independently. Jake's decision is authoritative; the agent result stays hidden until Jake commits. Deterministic warnings stay visible. Plan-delta comparison for proposed revisions by default; render ~20% of shadow revision proposals as a quality sample (S5). Requeue ~10% of Jake's past decisions at least two weeks later, blinded, to measure human repeatability (S12). Insufficient comparison counts extend this phase beyond day 60.

### Agent-first-held phase (earliest days 61–90)

Run no fewer than 30 complete agent-first-held calendar days. Agent reviews first; can accept, revise, or replace. Every delivery remains held; Jake audits before release. Store agreement, override, extra feedback, and correction. Insufficient audit counts extend this phase beyond day 90.

### After autonomy

Humans review every exception; initially every automatically revised clip. Every new church: human review for its first four services and full audit for its first two autonomous weeks (Decision H). At ≤100 churches, blind-audit 10% of autonomous clips. A complaint triggers a blinded retrospective audit of that church's trailing two weeks (Decision I). Keep a stable absolute blind-audit volume as the percentage falls at scale. Audits are blinded — the auditor records a decision before seeing the agent's.

### First P7 commit sketch

**Commit:** `feat(review-program): define fixed modes and evidence gates`

- **Outcome:** Pure mode and gate evaluation. It cannot enable publishing.
- **Files:** New `src/lib/review/operating-mode.ts`; new `src/lib/review/evidence-gates.ts`; new `tests/review-operating-mode.test.ts`.
- **Migration:** None. Wave 2 reserved durable program state.
- **Tests:** Exact day 30/31/60/61/90/91; insufficient counts; explicit promotion; kill-switch dominance; new-policy reset.
- **Decision log:** None until a production caller is added.
- **Rollback:** No production caller.
- **Trace:** Rev2 §9 and §13 P7; Addendum Decisions E, F, H, I; S5, S12.

### Shadow-to-agent-first gate (all required)

- Full 30 human-only days completed.
- Full 30 blind-shadow calendar days completed. A pause extends the phase; it never counts toward the 30 days.
- At least 150 blind comparisons.
- Zero critical safety false accepts.
- Noncritical false-accept rate no more than five percentage points worse than measured Jake repeatability (S12 defines the measurement).
- Median boundary difference ≤1.5 seconds on mutual accepts.
- Deterministic gates catch all known benchmark safety failures.

### Agent-first-to-autonomy gate (all required)

- Full 30 agent-first-held calendar days completed and day 90 has passed. A pause extends the phase.
- At least 300 audited agent-first decisions.
- Human override rate ≤5 percent.
- Zero safety overrides in the trailing 150 decisions.
- High-confidence override rate ≤2 percent.
- Exception routing captures ≥70 percent of remaining overrides.
- Exception volume ≤15 percent.
- Kill switch and rollback have passed a live-safe test.
- Jake explicitly promotes the exact policy version.

### Required P7 tests

Blind-result release rules; Jake cannot see subjective agent output first; deterministic warnings remain visible; agent-first delivery is always held; kill switch immediately restores human hold; policy rollback; new-church first-four-services rule; first-two-autonomous-weeks audit; random blinded audit selection; complaint trailing-two-week audit; human repeatability sample timing; agent revision plan-delta comparison; twenty-percent shadow render sample; model/prompt/detector version change resets confidence evidence as defined.

### P7 main risks

- One-church data collection is slow (see §6 — this is arithmetic, not pessimism).
- Calendar pressure causes weak promotion.
- Jake becomes anchored by agent output.
- Repeated clips from one church create false confidence.
- Rare safety failures do not appear in live data.

---

## 17. P8 — General learning and controlled policy improvement

### Objective

Make one general editing agent more like Jake. No church-specific editing profiles. The agent never trains itself from unaudited agent decisions.

### Trusted learning rules

- Human `ACCEPT` is a positive example for the exact final checksum.
- `REVISE` is an edit-delta example.
- `REPLACE` becomes a preference pair only after the replacement receives `ACCEPT`.
- A mechanical visual replacement does not train the content ranker.
- Several feedback items stay as several signals.
- Unaudited agent-only decisions are not trusted labels.
- Church likes and optional customer approvals do not directly train the global editorial policy.
- Split train and evaluation data by church and source service; also use time-based holdouts.

Improve in this order: (1) deterministic safety rules; (2) candidate construction and boundary rules; (3) prompt instructions and examples; (4) small failure classifiers when labels are sufficient; (5) fine-tuning only after the simpler work stops improving held-out results.

### First P8 commit sketch

**Commit:** `feat(learning): build versioned replay cases from human reviews`

- **Outcome:** Deterministic hashed replay manifests from authorized frozen snapshots. No customer-media export; no model training.
- **Files:** New `src/lib/learning/replay.ts`; new `src/lib/learning/examples.ts`; new `tests/learning-replay.test.ts`.
- **Migration:** None.
- **Tests:** Deterministic hash; exact source; positive example; revision delta; invalid replacement pair; multi-feedback preservation; church leakage prevention.
- **Decision log:** None.
- **Rollback:** No production caller and no trained artifact.
- **Trace:** Rev2 §§7.3 and 13 P8; product-owner instruction to improve the general agent.

### P8 milestone work

Frozen replay cases; church- and time-safe train/evaluation splits; recurring feedback → regression tests; valid preference pairs; mechanical vs. content failure labels; candidate-vs-active policy comparison on all safety, quality, and cost gates; explicit policy promotion; version storage for dataset, policy, prompt, model, detector, cost, and rollback; exceptions and blind audits as active-learning inputs.

### P8 acceptance gates

- Every trusted example traces to a human-reviewed exact render.
- Replay is deterministic.
- No church/source leakage between train and evaluation.
- Multiple feedback items remain separate.
- Invalid replacement pairs are excluded.
- Agent-only labels do not contaminate training.
- A candidate policy has zero critical safety regression, improves held-out editorial quality, and does not exceed approved cost.
- A new model or prompt starts with conservative confidence.
- Production promotion is explicit and reversible.

### P8 main risks

- Early data overfits the first church.
- Jake's decisions are not perfectly repeatable.
- Agent-generated labels leak into trusted data.
- A policy improves agreement but becomes less safe.
- Long-lived evidence creates privacy and deletion obligations.


---

## 18. Smallest MVP that can prove quality improvement

Do not start with the complete autonomous loop.

### Foundation MVP

Build P0 through P3. The atomic same-project reserve transaction already lands in P2.7; P3 completes the candidate and operator experience. This produces: safe continuous exports; exact edit-version and checksum identity bound to slots; correct weekday scheduling; fail-closed publishing; actual ranked candidate pools up to the internal ceiling; exact final playback for scheduled clips; Jake's decisions and unlimited feedback; a safe reserve queue; explicit exception recovery; and complete per-stage cost facts with provider provenance.

This foundation does not claim that the new agent improves quality. It creates trustworthy evidence.

### First quality experiment

Add only this thin P4/P5 slice:

1. FFmpeg silence and scene evidence.
2. One uncropped 480p proxy.
3. Sparse slide and pastor-visibility detection.
4. Sentence/silence boundary choices.
5. Edge-slide boundary salvage.
6. A shadow Selector that produces an alternate ranked pool.

Run current and proposed selection on the same services. Hide system identity and randomize presentation. Jake reviews the scheduled final renders.

The first outcome to improve is:

```text
ACCEPT without any human edit
```

The provisional success rule:

- Zero new critical safety errors.
- Zero known forbidden overlap in a proposed deliverable.
- At least 90-percent labeled slide-second recall before autonomy.
- A clear increase in acceptance-without-edit on the same service set.
- No increase in typical direct-upload COGS above $8/month.

Set the exact minimum improvement after P0 measures the current baseline. Do not choose a target that the baseline makes meaningless.

---

## 19. Testing methodology

### 19.1 Test layers

1. **Pure unit tests:** interval math, candidate limits, schedule allocation, feedback policy, eligibility, budgets, gates.
2. **Database integration tests:** claims, races, append-only review, migrations, reanalysis, reserve promotion, publisher reconciliation.
3. **FFmpeg integration tests:** exact cuts, continuity, captions, crop, probe, black/freeze/silence, checksums.
4. **Browser E2E tests:** operator review, multiple feedback, service settings, calendar states, authorization. (Today there is exactly one Playwright spec; each UI phase grows this suite.)
5. **Offline labeled-corpus tests:** forbidden detection, slide recall, pastor visibility, boundaries, rank quality.
6. **Blind human comparisons:** current vs. proposed Selector; Jake repeatability.
7. **Live-safe operational tests:** kill switch, rollback, PERC retrieval, proxy import, sandbox publishing (note: "sandbox" is a real Meta Page in Pulpit Engine's Business Manager, not a mock transport — treat those runs as production-adjacent).

### 19.2 Corpus coverage

The benchmark should include, with permission: one and two service schedules; different church timezones and service weekdays; wide stage shots; tight pastor shots; multiple speakers; worship with speech between songs; announcements; prayers; baptisms; altar calls and other non-sermon content; scripture slides; title, main point, subpoint, numbered point, and transition slides; short edge slides; necessary middle slides; slides with a printed photograph of a person; camera cuts, black frames, and freeze frames; noisy, reverberant, and low-volume audio; naturally clean and naturally poor delivery.

Do not commit private media to Git. Store controlled artifact IDs and checksums.

### 19.3 Comparison design

- Use the same source service for both systems.
- Randomize candidate order.
- Hide the system name and Selector scores.
- Review the exact final render for delivery decisions.
- Split evaluation by church and service, not by individual overlapping clip.
- Keep a time-based holdout.
- Requeue ~10% of Jake's old decisions after at least two weeks to measure self-agreement.

---

## 20. Metrics

### Safety

- Delivered known forbidden overlap: **0**
- Delivered known full-screen-slide overlap: **0**
- Meaning-altering automatic internal cuts: **0**
- Critical false accepts during promotion windows: **0**
- Full-screen-slide recall by detector version
- Ambiguous-region escalation and exception rate

### Editorial quality

Acceptance without edit; `REVISE` rate; `REPLACE` rate; top-choice acceptance; boundary-delta distribution; complete-thought score; hook acceptance; title/hook correction rate; reserve ranks consumed; human-agent decision agreement; human-agent feedback-category agreement; Jake repeatability.

### Visual and render quality

Caption timing failure rate; caption safe-area failure rate; crop/face containment failure rate; black/freeze failure rate; audio-level and silence failure rate; render/QC retry rate; rerenders per accepted clip.

### Operations

Review minutes per church; exception rate; time to first eligible clip; promotion-render latency; `BLOCKED`/`UNFILLED`/`MISSED` dates; publish reconciliation incidents; kill-switch use.

### Economics

Source bytes and cost per source hour; proxy bytes and cost per church; cost per service; cost per retained candidate; cost per accepted scheduled clip; cost per church per month; tokens and images per stage (with provider/model provenance); render CPU per final minute; cache hit rate; revision and replacement cost; storage GB-days by retention class.

---

## 21. Quality, cost, and complexity priority

| Component | Expected quality effect | Reliability effect | Typical monthly incremental cost | Engineering complexity | Priority |
|---|---|---|---:|---|---:|
| Export version pinning, slot binding, and exact checksum | High safety | Very high | Near $0 | Medium | 1 |
| Continuous-source enforcement | High faithfulness | Very high | Near $0 | Medium | 2 |
| Exact human review data | Very high learning value | High | Human pilot labor | Medium-high | 3 |
| Forbidden-region and slide detection | Very high | Very high | ~$0.43 including local and paid detection | High | 4 |
| Better natural boundaries | High | High | Near $0 after evidence exists | Medium | 5 |
| Delivery Eligibility and publish intent | High safety | Very high | Near $0 | High | 6 |
| Review Agent | High final quality | High after gates | ~$0.35 | High | 7 |
| Enriched Scribe transcript | Medium-high | High | ~$2.26 | Medium | 8 |
| Direct upload/PERC intake | No direct edit effect | High intake reliability | Saves up to ~$10 versus proxy | Medium-high | 9 |
| Global replay learning | Long-term high | Medium | Low until training | High | 10 |
| Fine-tuning | Unknown until enough data | Risky early | Variable | Very high | Last |

The best near-term quality-per-dollar work is: (1) prevent forbidden and slide content; (2) improve starts and endings; (3) review the exact render; (4) replace poor-delivery candidates instead of cutting their middle.

---

## 22. Deployment sequence

1. Jake gives final approval for this corrected plan. No code or external mutation starts before that approval.
2. Land P0.0: record the public-repository policy, the P5 go-private trigger, and the never-commit-while-public list. Confirm the four required checks are still active on the public repository. No visibility change today.
3. Prepare P0.0/P0.1 on the branch. Include the completed Section 9 production audit. The sandbox hold is closed: auto-posting is off in both workspaces, the sandbox Page ID is retained deliberately, and test post `999309073105794` remains as evidence.
4. Land P0.0, P0.1, then P0.2. The P0 pull request intentionally includes baseline commit `004db2f`. Do not merge the competing trim branch without a separate review.
5. Merge the evaluator, charter tests, candidate controls, heuristic guard, and non-schema telemetry (P0.3–P0.13). Keep candidate default and maximum at 18 until evidence supports a change.
6. Land the face-tracking copy fix and combined preflight (P0.14–P0.15).
7. Land P0.16 with `AUTOMATIC_PUBLISHING_ENABLED=false`. Keep it false through P1 and P2 sandbox preparation.
8. Run the collision and legacy-export audits against production data.
9. Drain workers and deploy Wave 1 (P0.17) through the web migration. Deploy compatible workers and resume them. Do not enable publishing after the Wave 1 smoke check.
10. Land rollups and worker-tick isolation (P0.18). Pass one real-service Gate A report (P0.19), including storage/egress and provider provenance. Produce the P0.20 plan-grid report for Jake's later business choice.
11. Deploy P1 in order. Keep legacy unpinned exports ineligible. Smoke-test one pinned continuous export.
12. Deploy P1.9 with `AUTOMATIC_SCHEDULE_ARMING_ENABLED=false` and `SOURCE_RETENTION_DELETION_ENABLED=false`. Enable schedule arming only after its new allocator smoke test. Keep retention deletion false for at least one complete report-only cycle and inventory review.
13. Complete P1.11/P1.12. Prove the publisher cannot bypass the false global switch and cannot use a latest-export lookup.
14. Deploy Wave 2 (P2.1) through the web migration and bootstrap Jake as platform operator (P2.2).
15. Deploy P2.3–P2.8 while global publishing remains false. P2.4's automatic coordinator must remain a no-op; explicit scheduled manual renders remain available for the controlled proof.
16. Smoke-test P2.7 atomic `REPLACE`, including priority rendering, exact slot rebinding, and the empty-reserve transaction.
17. Prepare one scheduled sandbox clip with a manual pinned render. Pass QC, record exact human `ACCEPT`, and prove every eligibility input except the global switch.
18. With publishing still off, prove that exactly one intended sandbox row has `PUBLISHING_DISABLED` as its only failing reason. Prove that every other due row has another block. Run a dry census that simulates only `AUTOMATIC_PUBLISHING_ENABLED=true`; it must contain exactly the intended sandbox row and no other workspace. Then temporarily set the real switch to true for one controlled sandbox-Page call. Verify that the published provider ID came from the exact accepted export. On any failure or mismatch, set the real switch to false immediately and stop.
19. If the sandbox proof succeeds, keep the switch true so the P2.4 coordinator can create scheduled review renders; unreviewed files remain blocked by Delivery Eligibility. Execute P2.9 and explicitly start the 30-day `HUMAN_REFERENCE` period.
20. Deploy P3 in order as a non-blocking operator/church experience improvement. P3 does not change the human-reference start date.
21. Use measured P0 and P2 evidence to write and approve the detailed P4–P8 commit update, including exact models, thresholds, and budgets.
22. Deploy Wave 3 before any worker writes media-region or artifact rows.
23. Run new Selector and Reviewer behavior in shadow before either can influence authority.
24. Require 30 complete days in each review phase plus all evidence-count and safety gates. Promote modes only through an explicit Jake action.

---

## 23. Highest-risk rollback boundaries

- **Wave 1 date uniqueness:** run the preflight and drain workers. Fix duplicate data forward.
- **Export provenance:** historical files can remain downloadable, but they are not auto-deliverable. Re-render instead of inventing a version.
- **Continuity:** hold legacy internal-cut exports until conversion. Never ship concatenated speech.
- **Scheduler:** schedule-arm kill switch. Do not restore rank-plus-date behavior.
- **Publisher:** the P0.16 global kill switch. Do not restore latest-export lookup or blind external retries.
- **Retention:** revert to report-only mode. Never delete on unverified key inventories.
- **Heuristic guard:** temporary explicit `ANALYSIS_ALLOW_HEURISTIC` if Claude is down and analysis must proceed for triage — visible and logged, never a silent revert.
- **Review:** keep append-only rows even if the UI rolls back.
- **Range derivatives:** keep the original-source fallback until checksum, coverage, and visual-quality tests pass. Delete early only after proof.
- **Agent policy:** roll back to the last promoted version and human hold. Never edit a production prompt in place without a version.
- **30-day clock:** an outage can extend the phase. It cannot shorten it.

---

## 24. Video Use decision

Borrow the architecture. Do not add Video Use as a runtime dependency now.

Pulpit Engine already has its own queue, storage, editing, render, approval, and publishing systems. Replacing them would add risk without a clear benefit. Adopt the ideas: transcript-first reasoning; structured source metadata; on-demand visual tools; agent edit plans; deterministic render tools; exact-output critique and revision.

Evaluate an individual Video Use component only if it has a clear license, passes the benchmark, fits the current job/storage boundaries, and is cheaper to maintain than the local module. (This matches the CTO.md build/buy/integrate framework: the editorial decision engine and its evidence loop are core proprietary IP — build; commodity capabilities remain buy/integrate behind abstractions.)

---

## 25. Decision document

### Chosen direction

- Improve the current application in phases.
- Make safety and provenance correct before adding agent authority — including retiring the silent heuristic fallback and the latest-export publish path that exist today.
- Use one global editorial standard.
- Build internal candidate controls now.
- Keep every deliverable continuous.
- Render final MP4 files only for scheduled or promoted clips.
- Build a reusable derivative and Media Region Index.
- Use local/deterministic detection first and one paid ambiguity escalation.
- Review the exact final file.
- Learn from Jake's frozen human evidence, not from unaudited agent output.
- Treat intake economics as the first financial optimization target.

### Why

This order gives the highest quality and reliability for the least cost, and it prevents corrupt training data. An agent cannot learn well if the system cannot prove which edit version produced the reviewed file — or whether Claude even produced the analysis.

### Rejected directions

Sending the complete service to a multimodal model; rendering all retained candidates; continuous per-frame paid vision; padding to 18 weak clips; one backup row for each primary clip; internal word or pause deletion; church-specific editing profiles; silent production fallback to a heuristic ranker; unlimited agent rerender loops; time-only autonomy; a full Video Use replacement; fine-tuning before trusted data and replay tests exist.

---

## 26. Out of scope for this product phase

- Three or more services per week
- Multi-range clips
- Internal pause, filler, word, or phrase removal
- B-roll generation
- AI-written replacement speech
- Continuous full-service multimodal viewing
- A church-specific editorial taste model
- A large permanent feedback-code taxonomy before day 30
- Automatic cross-project reserve borrowing
- A full staff administration dashboard
- Unbounded source extension after the safe candidate handles expire
- Fine-tuning before replay and held-out evidence justify it
- A broad product rename from `sermon-clipper` (`DECISIONS.md:872`)

---

## 27. Business items that can be confirmed later

These items do not block P0.0 or P0.1. The former sandbox-cleanup gate was closed by the 2026-08-11 production audit:

- Number of pilot churches (one committed today). Evidence gates, not a recruiting promise, control autonomy.
- Final plan-grid and included-minute design after P0.20 validation (including the presign-gate UX fix if Jake wants it).
- Final archive retention longer than the 12-month economics model.
- Exact PERC adoption point after one end-to-end proof.
- Exact local vision/audio models after license and corpus tests.
- Exact self-hosted ASR trigger after real Scribe spend and quality data.

---

## 28. Next action

After Jake's final approval, the first commit is **P0.0**:

```text
docs(repo): record the public-repository policy and the go-private trigger
```

No GitHub setting changes today. The repository stays public through P0–P4; the go-private trigger fires at the start of P5 (§14). `CTO.md` and the margin/scale projections are simply never committed while public (§5.0).

Then P0.1 is:

```text
chore(repo): commit sandbox evidence and catch up the decision log
```

followed immediately by **P0.2**:

```text
docs(agentic-editor): freeze the accepted product rules
```

P0.1 has no remaining sandbox merge gate. After it lands, build P0.3 and P0.4 before changing analysis behavior. Do not start P4 vision work first. The system needs trusted cost, export, review, and scheduling facts before the agent can improve safely.

---

## Appendix A — Wave 1 consumer audit

Every Wave 1 schema element and its named consumer, so nothing ships without a reader:

**Audit result (2026-08-11): PASS.** P0.17 and this appendix contain the same 13 Wave 1 elements. No element is missing from either list, and every element has a named writer and reader or database-enforcement consumer. The QC fields are counted as one schema group in both places.

| Wave 1 element | Written by | Read by | Notes |
|---|---|---|---|
| `ExportJob.editVersion` (nullable) | P1.2 enqueue; P2.4 coordinator; P2.7 replacement; P3.6 explicit fill | P1.1 render; P1.11/P2.8 eligibility | Historical rows stay null = permanently ineligible (P0.15 census sizes the blast radius) |
| `ExportJob.priority` | P2.7 atomic replacement; P3.6 explicit fill | P2.7 `claimNextExportJob` ordering change | First consumed in P2, not dormant through P3; `runAfter` already exists |
| QC result + QC-time checksum | P1.3 | P1.11, P2.5, P2.8 | Asserted equal to `ExportedFile.checksum`; one source of truth |
| `ServiceSlot.UNMATCHED` | P1.8 derivation; P1.10 correction | P1.9 allocator | One exact name; unmatched projects stay reserve-only |
| `GeneratedClipStatus.SUPERSEDED` + `supersededAt` | P2.7 atomic REPLACE | P1.11 eligibility; P2.7 reserve policy; P3 read models | |
| `SchedulePublishStatus.BLOCKED/UNFILLED/MISSED` | P1.9 allocator; P1.12 publisher | P1.11 eligibility; P2.4 coordinator; calendar UI | |
| `ScheduledPost.exportJobId` | P2.4 coordinator; P2.7 replacement; P3.6 fill | P1.11 (fail closed on null), P1.12, P2.5, P2.8 | Nullable unique exact-export binding with `SET NULL` |
| `ScheduledPost.projectId` | Wave 1 backfill; P1.9 new slots | P2.7 replacement; P3 pool/fill views | Preserves owning service project when clip is null or borrowed |
| Partial unique non-`MISSED` `(workspaceId, scheduledDate)` | DB constraint | P1.9 collision handling; P3.8 explicit reschedule | Only `MISSED` is excluded; P0.15 preflight required first |
| `OperationalEvent.clipId` | P1.3 QC events; P1.12 publish events | P0.18 rollup attribution | |
| `DailyCostRollup` | P0.18 rollup task | P0.18 report; operations page | |
| `PublishAttempt` (intent storage) | P1.12 | P1.12 reconciliation; audits | Append-only |
| `EditorialException` + lifecycle | P1.9 UNFILLED; P1.12 indeterminate; P2.7 shortage; later P3/P6 | Operator surfaces; P3 resolution; P7 exception metrics | OPEN/RESOLVED evidence is retained, not deleted |

## Appendix B — Renumbering map (draft → final)

| Draft | Final | Change |
|---|---|---|
| — | P0.0 | **New:** public-repository policy, P5 go-private trigger, and the never-commit-while-public document list (§5.0) |
| — | P0.1 | **New:** working-tree + decision-log hygiene |
| P0.1 | P0.2 | Adds this plan to the frozen docs |
| P0.2 | P0.3 | Unchanged |
| P0.3 | P0.4 | Charters post-`c1603cd` behavior incl. Sunday spill |
| P0.4 | P0.5 | Distinguishes candidate limit vs. scheduled count; extracts `readTargetClipCount` |
| P0.5 | P0.6 | Unchanged |
| P0.6 | P0.7 | Adds occurrence snapshot; file list corrected to the single write point |
| P0.7 | P0.8 | Unchanged |
| — | P0.9 | **New:** block silent heuristic analysis in production (S4 blocker) |
| P0.8 | P0.10 | Adds provider/model provenance |
| P0.9 | P0.11 | Unchanged (notes zero metering exists today) |
| P0.10 | P0.12 | Unchanged |
| P0.11 | P0.13 | Corrected defect-chain cites; adds export-path integration assertion |
| P0.12 | P0.14 | Unchanged |
| P0.13 | P0.15 | Extended: + historical-export census |
| — | P0.16 | **New:** global publisher kill switch |
| P0.14 | P0.17 | Wave 1 + `UNMATCHED`, exact export/project slot bindings, exception lifecycle, non-`MISSED` index, checksum SoT; runbook uses P0.15/P0.16 |
| P0.15 | P0.18 | Extended: + per-block worker-tick isolation |
| P0.16 | P0.19 | Extended: + storage provider/egress facts (S2), provenance |
| P0.17 | P0.20 | Extended: accumulation nuance, Stripe-env prices, presign-gate note |
| P1.1–P1.7 | P1.1–P1.7 | P1.2 adds the midnight-rotation fix; P1.3 adds clipId events + checksum equality; P1.5 notes concat-path retirement |
| P1.8 | P1.8 | Extended: + `deriveServiceSlot` UNMATCHED fix, `weekdayNameInTimezone` export |
| P1.9 | P1.9 | Extended: + staged retention activation (report-only), exceptions on UNFILLED, snapshot-sourced occurrence |
| P1.10 | P1.10 | Unchanged (also remedies pre-P1.8 misfiled snapshots) |
| P1.11 | P1.11 | Extended: + slot-binding input, kill-switch absorption, explicit ClipApproval relocation |
| P1.12 | P1.12 | Extended: explicitly deletes the latest-export lookup; `EditorialException` from Wave 1 |
| P2.1 | P2.1 | `EditorialException` removed (now Wave 1) |
| P2.2–P2.3 | P2.2–P2.3 | Unchanged |
| P2.4 | P2.4 | Writes `ScheduledPost.exportJobId`; adds central final-render eligibility and global-switch coordinator guard |
| P2.5 | P2.5 | Adds cross-workspace signed-URL scoping |
| P2.6 | P2.6 | ACCEPT/REVISE and unlimited feedback only; partial REPLACE is impossible |
| — | P2.7 | **New:** atomic REPLACE, same-project reserve, supersession, exact rebind, priority enqueue and claim order |
| P2.7 | P2.8 | Exact acceptance keys on the bound export |
| P2.8 | P2.9 | Human-reference start uses Gate C + controlled P2 sandbox proof; no P3 dependency |
| P3 sketch | P3.1–P3.9 | Full candidate/operator experience; reserve transaction moved to P2.7; explicit fill and missed-date recovery added |
| P4–P8 sketches | P4–P8 | Provisional evidence-based direction; exact commits/models/thresholds require the measured P0/P2 planning update |

**Implementation-ready count through P3: 51 commits** (21 P0 including P0.0 + 12 P1 + 9 P2 + 9 P3). P4–P8 have no frozen total; each currently has one provisional first-commit sketch and must be re-planned from measured P0/P2 evidence.

---

*This document is a final approval candidate. First action after Jake approves it: P0.0. The plan received its pre-code verification and sequencing reviews, including Jake's final correction decisions, as summarized in §0.*
