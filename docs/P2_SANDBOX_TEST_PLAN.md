# P2 Sandbox — Test Plan

**Prepared:** 2026-09-09. **Status:** section 1 is in progress. Read-only system
and sandbox checks were completed in the recorded snapshot. Jake supplied listening
findings for all six clips. Corrections and extended-range checks remain pending.
The production backup and recovery decisions were deferred on 2026-09-10; they
remain release gates, but do not block local P2 preparation. Sections 2–6 have
not been run. This file remains uncommitted.

PR #105 merged as `1d77d399a10ab70591974c3a8b4dc110a34e4109`. All four required
checks passed on its final head, `606c424`. Local main was updated to the merge.
Confirm the deployed revision before using the new alert in a production test.

Use `https://web-production-2a243.up.railway.app`. Use the operator account
`jake@jakegandara.com`.

This plan covers the three missing P2 proofs. Preparation changed no production
settings, started no processing or rendering, published nothing, and did not start
the 30-day phase. Future steps that write data require a separate instruction from
Jake. This document does not authorize those steps.

## 0. Verified starting point

Production was read on 2026-09-09. The project snapshot was taken at 11:44:07 UTC
(06:44:07 America/Chicago). These facts must be checked again before execution.

| Item | Observed state |
|---|---|
| Human-reference phase | Not started |
| Exact accepted render | Missing |
| Atomic replacement | Missing |
| Sandbox publication under the P2 evidence rules | Missing |
| Worker `AUTOMATIC_PUBLISHING_ENABLED` | `false` |
| Worker `AUTOMATIC_SCHEDULE_ARMING_ENABLED` | Unset; code defaults to false |
| Worker `SOURCE_RETENTION_DELETION_ENABLED` | Unset; code defaults to false |
| Primary / backup provider | `scribe` / `whisper_cpp` |
| First Baptist Demo service | `P3 Demo Test — Clip Count Retest 8-11` |
| Project ID | `75108e04-d3cd-49fd-a854-927e6501c04b` |
| Demo workspace ID | `4c949b5a-e401-40a2-82cb-979543eb6cd2` |
| Transcript / pool | `whisper_cpp`; 6 clips |
| Demo scheduled slots / exports | 0 / 0 |
| Demo human edits / approvals / editorial reviews | 0 / 0 / 0 |
| Demo transcription hold | OPEN; `9c7feb0b-0d2e-4f10-b939-1d82cac8108b` |
| Demo Facebook connection | Not configured |
| Dedicated publishing workspace | `Tier 3 Sandbox Test`; `7e56d1fd-6ab6-4fb3-8810-17dec32b4f25` |
| Stored sandbox Page ID | `1128280933691493`; workspace auto-posting is false |

The Page ID is a database observation. Current Meta access and the Page identity
were not checked. First Baptist Demo and the dedicated publishing workspace are
different workspaces. The demo service is suitable for read-only caption review;
it is not ready for the publishing proof.

## 1. Read-only readiness and caption review

This section started on 2026-09-09. Do not save edits, enqueue jobs, change
settings, record review decisions, or clear holds during this section.

- [x] Read `/api/health`. Record the deployed commit, migration status, and worker health.
  Notes: At 12:08:45.922 UTC (07:08:45 CDT), production reported commit
  `1d77d399a10ab70591974c3a8b4dc110a34e4109`, status `ok`, no incomplete Prisma
  migrations, a reachable database, and a worker heartbeat 6 seconds old.
  The health response reported global automatic publishing disabled.
- [x] Open `/app/operator/review` and the demo operator project page. Confirm the
  new alert lists the demo service and the hold is still OPEN.
  Notes: Signed-in operator `jake@jakegandara.com` saw one backup-transcription
  alert. It linked to the named First Baptist Demo service. Its hold remained
  OPEN in the operator page and the 12:11:37 UTC database snapshot.
- [x] Read the current program status and evidence with `npm run program:status`
  and `npm run program:evidence` in the confirmed production context. These two
  commands read data. Record their output without credentials.
  Notes: Ran the two underlying scripts in the Railway production Postgres
  context. Status: the human-reference program has not started. Evidence:
  exact accepted render MISSING; atomic replacement MISSING; sandbox publication
  MISSING. No sandbox-proof audit event or program-start command was run.
- [ ] Read the six candidate transcripts and play their full source ranges. Jake
  compares every spoken word in each proposed test clip with the transcript.
  Check names, Bible references, missing words, added words, and meaning.
  Notes: Read the stored transcript segments and word timestamps for all six
  candidates, including adjacent text. Provider: `whisper_cpp`. Clip 1 source
  playback was started in Chrome. It returned to its start and paused without a
  reported media error. Jake confirmed all four transcript sections for clip 1.
  He also confirmed its opening, ending, and full meaning. Clip 2 needs changes; see its findings below.
  Jake has now supplied findings for all six clips. Clip 1 passed the reviewed
  audio and transcript checks. Clips 2–6 need changes; extended ranges still need
  complete transcript coverage and exact boundary checks. Browser
  playback state proves media playback, not that the audio matches the words.
- [ ] Check the words at each start and end. Listen for clipped syllables and
  sentence fragments. Record source timestamps for each problem.
  Notes: Text and word timestamps show possible sentence cuts in clips 2–6.
  The table separates preliminary timestamp estimates from Jake's listening findings.
  Exact revised boundaries remain pending. Word timestamps are provider estimates.
- [ ] Flag worship, announcements, prayer, or another forbidden region. Check the
  surrounding context when a clip could change the speaker's meaning.
  Notes: Clip 2 includes upcoming-speaker/series announcements at
  4:04.960–4:22.270. Clip 5 starts in speaker acknowledgements and the series
  introduction. Clip 4 also opens with series context. Flag these passages for
  Jake's region judgement. No worship or prayer was identified in the inspected
  text; this is not an audio-based clearance. Do not omit the reversal in clip 1
  after the speaker describes the objection to joy during trials.
- [x] Record caption corrections in notes only. Source playback does not prove
  the final caption layout, caption timing, crop, or render quality.
  Notes: During the read-only checks, only this local plan was changed. The table
  separates confirmed corrections from unresolved findings. No caption edit or editorial decision was saved in the app. Raw word
  tokens split some words (for example, `Philipp` / `ians`); segment text often
  joins them correctly. Neither representation proves the final caption display.
- [x] Inspect existing services and slots in Tier 3 Sandbox Test. Record which,
  if any, have source media, a usable primary transcript, an eligible scheduled
  slot, and at least one same-service reserve. Do not assume old exports qualify.
  Notes: Inventory below covers all six services and both sandbox slots. None
  meets all prerequisites. S3 HEAD checks confirmed the four named source MP4s
  exist (demo plus three sandbox sources), each 392,808,104 bytes. This check does
  not prove full media decoding or final render quality.

Use this table for each reviewed candidate. Jake supplies the quality judgement.

| Clip ID / rank | Source range | Words and context | Issues with timestamps | Jake's result |
|---|---|---|---|---|
| `352cc2a7-a98d-4094-8b49-dec66cc34ccb` / 1 | 2:55.570–3:52.190 | Objection to joy in trials, followed by the Christian response and Paul's prison example. | Jake confirmed “preaching from” against audio; he reports that the phrase ended around 3:10. Jake confirmed the first word, final word, and final sentence sound complete. He confirmed all three context parts and the full meaning. | FOCUSED CHECKS PASS: Jake reports, “The first word sounds complete.” He confirmed “preaching from,” ending around 3:10. He reports, “The final word and sentence sound complete.” He reports, “All three parts are present. The meaning is complete.” TRANSCRIPT COMPARISON PASS: Jake reports, “Section 1 matches every spoken word.” Section 1 covers approximately 2:55–3:04, through “Someone needs to explain this to me.” Jake reports, “Section 2 matches every spoken word.” Section 2 covers approximately 3:04–3:16, through “There's no such thing as happiness and trials.” Jake reports, “Section 3 matches every spoken word.” Section 3 covers approximately 3:16–3:38, through “How can suffering produce endurance?” Jake reports, “Section 4 matches every spoken word.” Section 4 covers approximately 3:38–3:52, through “chained in prison.” All four sections now match the spoken words according to Jake. This result does not prove final caption timing, layout, or render quality. |
| `913d7f9a-69da-4852-bc30-b77db9398811` / 2 | 3:26.410–4:22.270 | Opens with “The only joy…” from the prior thought. Changes to series announcements. | CONFIRMED corrections: “Chaz” → “Chas” at approximately 4:07.520–4:10.960 (Jake supplied the church's spelling); “expos it” → “exposit” at approximately 4:14.360–4:16.800 (Jake checked the audio). CONFIRMED ending issue: Jake reports, “I hear an extra or cut ‘And’ at the end.” The estimated `And` token spans 4:22.130–4:22.400; the clip ends at 4:22.270 and omits the following sentence. | CHANGES NEEDED: Jake reports, “Clip 2’s first word sounds complete.” He reports, “Clip 2, Section 1 matches every spoken word.” Section 1 covers approximately 3:26–3:38, through “How can suffering produce endurance?” He reports, “Clip 2, Section 2 matches every spoken word.” Section 2 covers approximately 3:38–3:53, through “chained in prison.” He reports, “Clip 2, Section 3 matches every spoken word.” Section 3 covers approximately 3:53–4:04, through “truly discern.” Section 4 (approximately 4:04–4:22, through “introduction message”) matches every spoken word according to Jake, except the confirmed “Chas” and “exposit” corrections. Ending check FAIL: Jake hears an extra or cut “And” at the end. Jake reports, “The clip should stop before the announcements.” Jake agrees with the recommendation for a proposed ending after “truly discern,” before the announcements around 4:04. The exact new endpoint, complete meaning of the proposed range, and resulting duration need review before any edit. The current range does not pass. Corrections are notes only; no app edit or hold change occurred. |
| `b6c4ad6f-388f-408d-b7bd-a18d35ec59f0` / 3 | 9:57.770–10:54.070 | Creator/creature distinction; Numbers chapter 23. | Jake specifies “the funny enough” → “funny enough” around 10:34 and “Balaon” → “Balaam” at approximately 10:36.800–10:39.160. Whether the extra “the” exists in the audio as a false start or only in the transcript remains unverified. CONFIRMED ending issue: Jake hears an extra “And of…” after the final sentence. | CHANGES NEEDED: Jake reports, “Clip 3’s first word sounds complete.” Jake reports, “Clip 3, Section 1 matches every spoken word.” Section 1 covers approximately 9:57–10:13, through “and your thoughts and ways.” Jake reports, “Clip 3, Section 2 matches every spoken word.” Section 2 covers approximately 10:13–10:31, through “between the creator and the creature.” Jake reports, “Clip 3, Section 3 matches except for ‘funny enough’ and ‘Balaam.’” Section 3 covers approximately 10:31–10:43, through “very true about God.” Jake confirms Section 4 (approximately 10:43–10:54) matches, but he hears an extra “And of…” after the last sentence. Ending check FAIL. Jake says the beginning is acceptable. He requests a proposed ending at 10:30, before the Numbers 23 section. He identifies a sufficiently long pause between two distinct thoughts. This replaces the earlier recommendation to end around 10:53. Proposed range: 9:57.770–10:30.000 (approximately 32.23 seconds). Jake confirms, “The phrase finishes before 10:30. The Numbers 23 section has not started.” The proposed ending passes Jake's listening check at the displayed 10:30 time. This is not a frame-accurate cut or final render test. A saved edit and final render review remain separate steps. Preserve the Numbers 23 transcript corrections as source findings; that section would fall outside the proposed clip. Findings only; no app edits or hold changes. |
| `0db5e46c-371c-4a4e-a8fc-d64fc3ec97d4` / 4 | 1:32.290–2:29.750 | Series title and examples of biblical paradoxes. | Opens after “It is titled Upside Down.” The earlier transcript-based estimate placed the end inside `you` (2:29.610–2:29.860); the gain-life clause continues to 2:33.720 in the transcript. Jake's listening report differs: he hears “you will gain” after “life,” and the player stops after “gain.” The exact word timing remains unresolved. The reported ending leaves the thought incomplete. | CHANGES NEEDED: Jake reports, “Clip 4’s first word sounds complete.” Jake reports that Section 1's phrase “for this series” ends around 1:44, and he hears “because” at 1:45. The assistant's 1:32–1:45 section label was approximate; this observation does not establish a stored timestamp error. Use approximately 1:32–1:44 for the first listening section. Jake confirms that Sections 1, 2, 3, and 4 match every spoken word. Jake places the Section 3 listening boundary around 2:12 because the speaker starts the next statement around 2:13. Treat this as a listening-section boundary, not an approved change to the clip endpoint. Jake confirms that the player stops after “gain”; he did not pause it there. Jake reviewed the full recording and confirms that “have life” finishes at 2:39 before the next example starts. Earlier proposed range: 1:32.290–2:39.000 (66.710 seconds). Jake supersedes this proposal with 1:32.000–4:04.000 (152 seconds). Jake reports that earlier endings leave the point unfinished. A complete sentence at 2:39 does not establish a complete message. This is a displayed-clock listening check, not frame-accurate or rendered-output proof. The proposed ending remains unsaved. Jake confirms that the final section matches every spoken word. All reviewed transcript sections now match the audio according to Jake; this does not establish full transcript accuracy for the new 1:32–4:04 range. Exact start/end boundaries, unreviewed words across the combined range, series context, and applicable duration limits remain pending. No clip edits were saved; the transcription hold remains open. |
| `33ca4981-27e7-454c-809a-777d86b86ad3` / 5 | 1:08.610–2:06.830 | Speaker acknowledgements, Isaiah 55:8, series introduction. | The transcript-based estimate places the start inside `Spencer` (1:08.370–1:08.760); Jake reports that the first word sounds complete. The listening report does not confirm that estimated cut. Jake reports that “the Lord is laid” should read “the Lord has laid” at approximately 1:10.560–1:13.400. Jake confirms that the speaker accidentally says “the Isaiah” at approximately 1:15.080–1:18.920. The stored words match the audio; Jake requests “Isaiah” for readable captions. This is an editorial correction, not a recognition error. Preserve the original transcript and audio. The earlier text review identified a trailing “and.” Jake hears “and they will” after “tension.” Jake confirms that the player stops after “and they will.” This ending leaves the thought incomplete. Final-word sound completeness remains unconfirmed. | CHANGES NEEDED: Jake confirms that Clip 5’s first word sounds complete. Section 1 needs the reported “is” → “has” correction. Jake confirms that all other Section 1 words match the audio. Jake confirms that all other Section 2 words match the audio. Jake confirms that Sections 3, 4, and 5 match every spoken word. Jake reports that “The paradoxes” enters around the approximate 1:32 listening boundary. Pause after “It is titled Upside Down,” before “The paradoxes”; this is a listening-section boundary, not a clip edit or verified timestamp error. Jake reports “and they will” after “tension” in the final section. Jake confirms that the player stops after “and they will.” The ending fails the complete-thought check. Final-section word accuracy, final-word sound completeness, a suitable complete-message range, and full meaning remain pending. No clip edits were saved; the transcription hold remains open. |
| `20d15185-270f-448f-91c1-8f9e6d819170` / 6 | 9:02.090–10:02.230 | Heaven/earth comparison depends on the preceding thoughts-and-ways passage. | Jake reports that “in the earth” should read “and the earth” at approximately 9:02.240–9:06.440. End cuts estimated `all` token (10:02.090–10:02.350), before “I know is that's where the heavens are.” | CHANGES NEEDED: Jake reports that the first word sounds as though the clip should start slightly earlier. Jake reviewed the full recording and selects 8:47 as the preferred start, with “He doesn't merely say my thoughts and ways / are slightly better or more better / than your thoughts and ways.” This is a displayed-clock listening preference; exact boundary and first-word sound completeness remain to be verified. Section 1 needs the reported “in” → “and” correction. Jake confirms that all other Section 1 words match the audio. Jake confirms that Sections 2, 3, 4, and 5 match every spoken word. Jake reports that the ending cuts off the final thought. The ending fails his complete-thought check. Final-section word accuracy, exact stopping words, and complete transcript coverage of the extended range remain pending. Jake confirms that the thought finishes before 10:30 and that the full 8:47–10:30 passage makes sense. The proposed ending and full meaning pass his displayed-clock listening check; this is not frame-accurate or rendered-output proof. The candidate range 8:47–10:30 lasts 103 seconds; applicable duration limits remain unchecked. No clip edits were saved; the transcription hold remains open. |

### Future transcript improvements requested during audio review

- Jake requests detection of accidental filler words and stutters, such as “the funny enough.”
- Distinguish recognition errors from words actually spoken. Preserve the original transcript and audio.
- Suggest readable captions without changing meaning. Do not remove deliberate repetition or change audio automatically.
- Jake requests a comprehensive biblical-name list, including “Balaam,” for spelling checks.
- Use passage context and approved spelling variants to avoid replacing one valid name with another.
- Keep church-specific approved names, such as “Chas,” alongside the biblical-name list.
- These are recorded requirements only. Implementation and validation remain pending.

### Complete-message selection requested during audio review

- Jake prefers one complete clip from 1:32 to 4:04 (152 seconds).
- Jake reports that shorter endings within this passage leave the point unfinished.
- Select a complete message, not merely a complete sentence.
- Jake withdrew the duplicate-prevention request. Overlap optimization is deferred for possible later discussion, with no current implementation requirement.
- Preserve earlier listening evidence.
- Verify supported duration limits and review unverified words and exact boundaries before applying this proposal.
- These are recorded requirements only. No clips were changed or removed. Implementation and validation remain pending.

### Sandbox inventory — 2026-09-09

Database reads: 12:11:37 and 12:13:08 UTC. Source existence was checked with S3
HEAD requests. No media was copied or downloaded for these checks.

| Service | Source / transcript | Clips / slots / reserves | Suitability |
|---|---|---|---|
| `Wednesday Night Church 5-20-26 "Upside Down" Part 1 Jake Gandara` — `e7ee7cf5-d096-4dfd-8593-65d6c0ec9fae` | No stored source key; no transcript | 0 / 0 / 0 | FAILED; cannot use as-is. |
| Same title — `269ddf06-2808-4e40-8eb9-ba8b794dcbfd` | No stored source key; no transcript | 0 / 0 / 0 | FAILED; cannot use as-is. |
| Same title — `6a17d5b2-56b2-4bb4-8421-773b06fe50ba` | No stored source key; no transcript | 0 / 0 / 0 | FAILED; cannot use as-is. |
| `Wednesday Night Church 5-20-26 Proxy Retry` — `b5d767fd-da16-4ed3-bf92-96b6d4f49de0` | MP4 exists; `whisper_cpp`, 978 segments | 0 / 0 / 0 | FAILED; no primary transcript or test pool. |
| `Full Pipeline Test` — `b83dad5c-fcc7-4dbe-b9d5-dc5151f361f1` | MP4 exists; `whisper_cpp`, 978 segments | 0 / 0 / 0 | FAILED; no primary transcript or test pool. |
| `Stage A Fix Verify 7-24` — `c3345a01-7e8b-4c23-b8fa-1270feb87d63` | MP4 exists; `whisper_cpp`, 978 segments | 2 / 2 / 0 | READY in the database, but unsuitable for the three-proof sequence. |

Stage A slot details:

- `4f5c9c02-2cfe-4cf2-84a4-ba5c9307150d`: 2026-07-24, INSTAGRAM,
  SUCCEEDED; clip `e6a02141-4a93-4a97-ba62-ce0f1d6bedca` (rank 1). No bound
  export. A stored SUCCEEDED row alone does not prove a real accepted publication.
- `f1f55332-e177-410a-be10-6611ad58e049`: 2026-07-26, FACEBOOK,
  NOT_STARTED; clip `9335324f-3132-4441-b99d-14ed75e3f8e8` (rank 2,
  `Young Preachers Announced for New Series`, 0:00.000–0:21.950). No bound export
  or review decision. The date is past; the row is not MISSED. Do not assume the
  MISSED-only reschedule action can move it.
- Both clips are scheduled. The reserve policy excludes scheduled clips.
  No same-service reserve is available. Other services cannot supply one.
- Its one old export, `6815e578-eefe-4234-bb89-018d98bd2967`, is SUCCEEDED but
  has no edit version, QC status, QC checksum, output-file relation, or slot
  binding. It cannot supply the exact-render proof. Rank 1 also has one
  non-system edit and one approval. Preserve this durable work.
- No sandbox service has an exception row. This does not make the old fallback
  transcripts primary-provider transcripts or prove their caption quality.

The demo still has six system-initial edits and no human edits, exports,
approvals, review decisions, or slots. Its fallback hold remains OPEN. Its six
unscheduled candidates cannot serve as reserves for a different service.

**Current next action:** complete the local readiness and release checks below.
Jake supplied listening findings for all six clips. Clip 1 passed its reviewed
audio and transcript checks; clips 2–6 need changes. Revised ranges still need
exact boundaries and full transcript coverage. Keep the demo hold open.
Record findings only. Prepare
a new P2 service in Tier 3 Sandbox Test with a primary transcript, one test slot,
and at least one unused same-service reserve. The inspected app code creates new
slots only in `src/lib/jobs/handlers/analyze.ts`, behind
`AUTOMATIC_SCHEDULE_ARMING_ENABLED`. The operator reschedule action moves existing
MISSED rows; it does not create slots. With arming off, a new processing run alone
will not provide a test slot. Jake then authorized local building while away.
The branch `codex/p2-sandbox-preparation` adds the staff command documented in
[P2_SANDBOX_SLOT_SETUP.md](P2_SANDBOX_SLOT_SETUP.md). It starts with a read-only
plan and permits a separately confirmed apply. It keeps global arming off,
retains a reserve, and enqueues no render. Review the code and test results before
any production apply or processing run. This command has not been run against
production. Also
confirm the supported source-reuse/primary-transcription path. The current
sandbox inventory supplies no ready service. Do not render Stage A or the held
demo to bypass these gaps. A new primary transcript/pool will need a fresh review.

Local independent check on 2026-09-10: the new staff command planned the handoff
without database writes. After exact confirmation, it created one service with
the requested May 20, 2026 date and `UNMATCHED` occurrence. It queued one
`FINALIZE` job and did not start it. The command refuses changed plans, bad
confirmation, unsafe automation, stale or non-fresh copies, and competing plans
for one source. The source-copy integration file passed 24 tests in a new
disposable PostgreSQL database. The database was removed. The command and usage
limits are in [P2_SANDBOX_SERVICE_HANDOFF.md](P2_SANDBOX_SERVICE_HANDOFF.md).
This proves the local control. It does not authorize a production copy, prove
Scribe account readiness, or run processing.

**Stop point:** choose the service and propose the exact next actions. Keep the
demo hold OPEN. A note that captions look correct does not clear it.

### Local readiness review and separate-service procedure — 2026-09-14

This review inspected local code and documents only. It ran no database command,
media read, worker, processing job, migration, deployment, or publishing action.
It did not change PR #106. Historical fixture results are not fresh test results.

#### Duration findings

- `src/lib/jobs/handlers/analyze.ts` generates candidate windows from 20,000 to 90,000 milliseconds.
- `src/lib/analysis/chunking.ts` stops window growth above 90,000 milliseconds.
- Three duration targets per start are 20, 55, and 90 seconds. Segment ends determine the actual lengths.
- `refineBoundaries` adds up to 150 milliseconds at each edge, within source bounds.
- This small padding cannot produce the proposed 152-second clip 4 or 103-second clip 6.
- Clip 1 is 56.620 seconds. Proposed clip 2 is 37.590 seconds. Proposed clip 3 is 32.230 seconds.
- Those three ranges fit the candidate duration band. This does not prove quality or publication eligibility.
- Clip 5 has no agreed complete range.
- `src/lib/editor/trim.ts` uses a 3,000-millisecond minimum and clamps trim handles to the source duration.
- The inspected editor state schema and render-plan code do not establish a 90-second editor maximum.
- Editor acceptance is not proof of supported long-form generation, export quality, or platform publication.
- Current external platform duration rules were not checked. Check them before any publication proposal.
- Do not shorten a complete message solely to satisfy the generator limit. Decide longer-clip support separately.
- Keep duplicate-prevention optimization deferred. This review adds no overlap requirement.

#### Separate sandbox service procedure

Each production step below remains unapproved. These are ordered release and execution gates.

1. Complete local review and disposable release rehearsal before requesting production execution.
   Review the uncommitted handoff command, its refusal/concurrency evidence, and the final PR head.
   Rehearse shutdown, the full migration chain, restore, rollback, and disposable R2 storage conditions.
   The deferred backup custody and restore-capacity decisions remain release gates.
2. Prepare the exact private execution manifest after separate read-access approval.
   Source project: `75108e04-d3cd-49fd-a854-927e6501c04b` in First Baptist Demo.
   Target: `Tier 3 Sandbox Test`, `7e56d1fd-6ab6-4fb3-8810-17dec32b4f25`.
   New service date: `2026-05-20`. Preserve the old `2026-08-11` service date and its evidence.
   Confirm the occurrence instead of treating `UNMATCHED` as an approved scheduling choice.
   Confirm operator/member IDs, target consent, import permission, entitlement, minute balance, transfer budget,
   primary-provider readiness, and the recovery owner. Historical snapshots do not supply current facts.
3. Obtain release and shutdown approval. Verify all job executors stop, including inline callbacks and restarted replicas.
   Verify the reviewed API, worker, and migration versions agree. Keep automatic publishing, arming, and deletion off.
   Local environment flags cannot prove remote executors stopped.
4. Follow `docs/P2_SOURCE_COPY_COMMAND.md` to prepare the source-copy plan.
   This reads source bytes for SHA-256; it is not a metadata-only check.
   Use a private path outside synchronized folders. Never commit storage keys or confirmation manifests.
   Review the exact source, target, byte limit, cost exposure, date, and identity before approving apply.
   Apply requires the exact plan hash and sandbox UUID within 30 minutes.
   Verify matching bytes/hash, one fresh source row, and a completed copy journal.
   Do not copy transcripts, clips, approvals, holds, or exports.
5. With all executors still stopped, prepare the service handoff plan from that completed copy.
   Follow `docs/P2_SANDBOX_SERVICE_HANDOFF.md`; use `npm run --silent prepare:sandbox-service` when redirecting JSON.
   The copied source must remain fresh, unused, and within its retention deadline.
   Review the saved plan and approve service creation plus one queued `FINALIZE` job separately.
   Repeat exact arguments with `--apply`, `--plan`, `--queue-finalize`, `--confirm`, and `--confirm-sandbox`.
   Verify one service, one queued job, no `startedAt`, and a private staff audit record.
   Queueing is not safe isolation when another executor can claim the job.
6. Request a separate controlled processing approval with the exact service, job, executor scope, and cost budget.
   Check other claimable jobs before starting any shared worker. Stop if isolation is unproved.
   Require the new primary transcript, fresh clip pool, and no open fallback hold.
   If fallback recurs, stop and investigate. Do not clear the hold manually.
   Keep the original demo service and hold unchanged.
7. Review the new primary transcript and candidates from scratch. Old clip IDs and listening passes do not transfer.
   Select one suitable clip and at least one unused same-service reserve. Record corrections only at this point.
   If no complete candidate fits current limits, stop and resolve selection/duration support before rendering.
8. Prepare `prepare:sandbox-slot` read-only output. Check date, workspace, source, primary transcript, hold,
   selected clip, and lowest eligible same-service reserve. Approve its exact apply separately.
   Create the slot before saving human edits, approvals, exports, or review records; those records cause setup refusal.
   Keep global schedule arming off. Verify the slot and reserve without starting a render.
9. After separate approval, apply needed caption/boundary edits and collect the P2 proofs in order:
   atomic replacement, exact accepted render, then sandbox publication.
   Verify Meta account/Page access and current platform limits before requesting publication approval.
   Watch the exact rendered MP4 for words, timing, layout, crop, audio, and complete meaning.
   Do not start the 30-day phase as part of these steps.

#### Remaining manual checks and decisions

- Check revised exact boundaries and extended transcript coverage for clips 2, 3, 4, and 6.
- Choose clip 5's complete range and review its final transcript section.
- Resolve the spoken-versus-transcribed extra “the” in clip 3; preserve the original audio and transcript.
- Confirm announcements and series context are appropriate for each proposed clip.
- Decide whether longer-message generation belongs in the next local implementation scope.
- Resolve occurrence, target consent, transfer budget, recovery ownership, backup custody, and restore capacity before release.
- Later verify live provider credits/permissions, worker shutdown, deployed revisions, and the dedicated Meta Page.
- Later review the new primary pool and exact final renders. Existing source playback proves none of the three P2 proofs.

Recommended next independent work: prepare and test a local complete-message duration design using disposable transcript fixtures.
Keep current production limits and duplicate-prevention behavior unchanged until a separate implementation decision.

## 2. Resolve transcription and service setup before durable work

**Future work; not authorized by preparation of this plan.**

The current code does not provide a manual transcription-hold dismissal action.
The automatic resolution path requires a primary-provider transcript, a successful
clip rebuild, and no human edits, approvals, or exports from the held transcript.
Editorial review records also block destructive reanalysis.

- [ ] Recheck durable-work counts before selecting a recovery path. Existing
  source-preview use is not a final export.
  Notes:
- [ ] After Jake fixes the provider account, propose one explicit primary
  transcription and analysis run, or select another suitable existing service.
  Obtain approval before any run. Do not edit captions or render the held demo
  first: those actions can prevent the normal recovery path.
  Notes:
- [ ] If a recovery run is approved later, verify the stored provider is
  `elevenlabs_scribe_v2`, the rebuilt pool is present, and the hold becomes RESOLVED.
  Re-record clip IDs and repeat caption review; the old pool is replaced.
  Notes:
- [ ] If durable work exists, stop and propose a supported recovery or a separate
  test service. Do not delete evidence or clear the hold by direct database edit.
  Notes:
- [ ] Select a scheduled slot in the dedicated sandbox workspace and record its
  clip and same-service reserve. The demo has no slots. If suitable setup is
  absent, propose the exact setup and obtain approval. Do not change global
  schedule arming merely to make the test proceed.
  Notes:

**Pass:** a named test service has reviewed captions, renderable source, no open
transcription hold, a suitable slot, and a same-service reserve.

**Fail/stop:** fallback recurs, media is missing, the hold stays open, durable work
prevents recovery, or no supported slot setup exists.

## 3. Proof A — Atomic replacement

**Future work.** Manual export and `REPLACE` enqueue rendering even while global
publishing is false. Both need approval before this section runs.

- [ ] Record the slot ID, date, platform, current clip/rank, and reserve order.
- [ ] Manually render the slot's current clip through the normal export path.
  Confirm it is the slot's bound export, is `SUCCEEDED`, and passes QC.
- [ ] Jake watches that exact file. Choose a clip with a real replacement reason;
  do not invent a quality finding for the test. Record the reason and select
  `REPLACE` through the operator interface.
- [ ] Verify one immutable `REPLACE` record names the old render. Verify the old
  clip is superseded and the lowest-ranked eligible same-service reserve is
  promoted. Ranks must not change.
- [ ] Verify the same slot retains its date and platform, binds the promoted
  clip and its export, and returns to `NOT_STARTED`. The replacement render has
  priority 100. Confirm it finishes and passes QC.
- [ ] Verify the old decision does not accept the new file. A fresh human
  decision is required. No post must publish while the global switch is false.
  Notes:

**Pass evidence:** old/new clip IDs, slot ID, old/new export IDs, `REPLACE` review
ID, rank order, unchanged date/platform, and replacement QC result.

The empty-reserve branch is a separate P2.7 smoke check. Use a separately approved
test case: expect an immutable replacement decision, an UNFILLED slot, and an OPEN
`reserve_pool_exhausted` exception. Do not exhaust the intended publication pool
to collect that evidence. Local/CI transaction tests do not prove this production
branch was exercised.

## 4. Proof B — Exact accepted render

**Future work.** Use the final replacement file from section 3 where suitable.

- [ ] Record the four review identity facts: clip ID, edit version, bound export
  ID, and output checksum. Confirm `qcChecksum` equals that checksum.
- [ ] Jake plays the entire final MP4 in the operator review page. Check spoken
  words, caption timing and layout, crop, audio, and both clip boundaries.
- [ ] If a correction is needed, use `REVISE`, make the approved change, and
  render again. Repeat the full check against the new file and identity.
- [ ] Jake records `ACCEPT` only after the exact file passes. Do not edit or
  render again after acceptance. A later change requires a new acceptance.
- [ ] Run `program:evidence` and verify the accepted-render and replacement
  proofs are present. Record the IDs it reports and confirm they are this test.
  Notes:

**Pass:** a slot is bound to a successful, QC-passed export with a human `ACCEPT`
of its current identity. Church approval, if required, is an additional gate;
it does not replace operator acceptance.

## 5. Pre-publication proof and separate approval

**Future work. Global publishing remains false during preparation.**

- [ ] Confirm the intended workspace, sandbox Page name and ID in Meta, current
  access, workspace plan eligibility, and a public media URL Meta can fetch.
- [ ] Propose any required workspace-only settings changes. The stored sandbox
  connection currently has auto-posting off. With that still off, switching only
  the global flag cannot make the row eligible. Any setup change needs approval.
- [ ] Make the chosen slot due only through an approved supported scheduling
  action. For MISSED rows, use the operator reschedule path. If it cannot handle
  the selected case, stop and propose a fix; do not copy the old checklist's
  direct-database backdating step.
- [ ] Check the intended clip's project for open transcription holds separately.
  Production baseline `1d77d39` checks holds outside `assessDeliveryEligibility`;
  its census omits them. Draft PR #106 adds census hold, workspace-access, and local
  configuration checks. It has not been deployed. Repeat the manual hold check.
  A census PASS is not proof of live Meta access, media retrieval, or permission
  to publish. Confirm the deployed code and worker configuration before use.
- [ ] Inventory every due row across every workspace. Confirm the exact render,
  QC, acceptance, approval, connection, holds, and slot state remain valid.
- [ ] After approval to record a dry-run audit event, run:

  ```bash
  npm run program:sandbox-proof -- --post <scheduled-post-uuid>
  ```

  This command makes no Meta call and changes no switch. It **does write an
  operational audit event**. It is not a zero-write inspection command.

- [ ] Require exactly the intended slot in `switchOnly`. All other due rows must
  have another block. Record the census timestamp and every reported reason.
  Repeat if any relevant state changes before publication.
  Notes:

**Stop point:** present the exact target, file identity, census, and hold check to
Jake. The command's success text is not permission to enable publishing.

## 6. Proof C — One controlled sandbox publication

**Not authorized now.** Obtain a separate instruction for the exact target and
the global switch change. Include how to stop publishing if the result differs
from the approved plan. Do not perform this section as part of caption review.

- [ ] At execution time, repeat the checks in section 5 before enabling anything.
- [ ] Verify the resulting slot is `SUCCEEDED`, has a provider post ID, and names
  the exact accepted export. Record the publish-attempt evidence.
- [ ] Jake opens the sandbox Page and confirms the video and captions match the
  accepted file. A database post ID alone does not prove what appeared on Meta.
- [ ] Compare all workspaces with the pre-call inventory. No other row may have
  published. An ambiguous outcome requires investigation, not a blind retry.
- [ ] Record the final global and workspace switch states. Continued operation
  after the proof must be an explicit decision; this plan does not authorize it.
- [ ] Run `program:evidence`. Require all three proofs and verify their IDs refer
  to the intended tests. The old July Tier 3 post alone does not meet these rules.
  Notes:

**Pass:** the exact accepted render reached the sandbox Page, no unintended row
published, and all three start preconditions are recorded.

## 7. Results and roadmap

| Proof | Current result | Evidence to record |
|---|---|---|
| Caption review | NOT TESTED | Candidate notes, then final MP4 review |
| Transcription hold cleared for chosen service | NOT PROVED; demo OPEN | Provider, exception state, recovery evidence |
| Atomic replacement | MISSING | Slot, review, old/new clip and export IDs |
| Exact accepted render | MISSING | Four identity facts, QC, human ACCEPT |
| Single sandbox publication | MISSING | Census, provider post ID, exact-export evidence, Jake's visual check |
| 30-day phase | NOT STARTED | Remains unchanged during this test plan |

After the proofs pass, prepare the explicit start of the 30-day human-reference
phase under [the runbook](HUMAN_REVIEW_30_DAY_RUNBOOK.md). Starting the clock needs
another instruction. It cannot be backdated or shortened.

Use measured P0/P2 cost, quality, failure, and review evidence to prepare and approve
the detailed P4–P8 plan before implementing their behavior. P4 builds the reusable
service representation and selects a conservative sermon corridor before paid
transcription. See [implementation plan §13](AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md#13-p4--derivative-first-sermon-understanding-and-media-region-index).

Sources: [P3 results](P3_EXIT_MANUAL_TEST.md),
[operator alerts](OPERATOR_TRANSCRIPTION_ALERTS.md),
`src/lib/transcription/fallback-hold.ts`, `src/lib/analysis/reanalysis-policy.ts`,
`src/lib/review/replace-scheduled-clip.ts`, `src/lib/review/editorial-program.ts`,
`src/lib/delivery/query.ts`, and `src/lib/integrations/facebook-publisher.ts`.

## Goal execution record — 2026-09-22

This section records local preparation only. All three operational proofs remain missing.
The branch is `codex/p2-sandbox-preparation`, at `86d1691`.
The working tree contains earlier edits and untracked work. No release candidate includes those files by implication.
No production check occurred. The September 9 inventory remains historical.

### Required preparation

- Resolve recovery decisions D1–D10 in `PR106_RELEASE_DECISIONS.md` before the planned release.
- D1–D3 are pending: recovery owner, primary key store, and independent key copy.
- Select the exact release contents before evaluating release evidence. Preserve unrelated files.
- The rehearsal harness pins candidate `65aab9e77e460777b0600657edfdad65ca940d1d` in `scripts/lib/release-rehearsal.ts`.
- That candidate differs from HEAD. Differences include the cleanup migration and source-copy and slot checks.
- Do not claim its evidence covers the current release. Obtain matching rehearsal evidence before release approval.
- The service handoff guide currently restricts its command to isolated databases.
- Prepare a reviewed production procedure before requesting production execution. Do not copy its example into production.
- Confirm service occurrence, target consent, budgets, and provider readiness before processing approval.
- Create the test slot before human edits, approvals, exports, or review records. The setup command refuses those records.

### Proof execution order

Each step requires its stated authorization. No approval transfers to a later step.

| Step | Required result | Separate authorization |
|---|---|---|
| Readiness | Current revisions, recovery facts, source identity, target permissions, and provider readiness | Read-only production inspection |
| Release | Reviewed candidate, backup, restore evidence, stopped executors, and compatible deployed versions | Exact release operations; merge remains separate |
| Source and service | Fresh copied source, separate service, one queued job, and no execution | Source copy, then service creation and queueing |
| Processing | Primary transcript, fresh pool, and no fallback hold on the new service | Exact job, executor scope, and cost budget |
| Slot | One scheduled clip and an eligible same-service reserve | Exact slot plan apply |
| Replacement | Immutable REPLACE, promoted reserve, unchanged date/platform, exact export binding, and QC | Manual export and REPLACE with rendering |
| Reserve exhaustion | UNFILLED slot and OPEN exception in a separate test case | Separate test setup and execution |
| Acceptance invalidation | An approved material edit blocks the former acceptance | Exact edit, review writes, and required renders |
| Final acceptance | Full human playback, matching four identity facts, QC, and fresh ACCEPT | Jake's final review and review write |
| Publication census | Exactly one intended switch-only eligible row; every other due row stays blocked | Required settings or scheduling changes, then audit write |
| Publication | Exact accepted file on the confirmed Page; no other publication; Jake's visual confirmation | Exact target, file, switch change, and stop procedure |
| Start decision | All three proof IDs, final switch states, review owner, and proposed start action | Separate instruction to start the 30-day period |

Run acceptance invalidation before final acceptance. Record both identities and the refusal of the old acceptance.
Then render, review, and accept the final version. Make no further changes before publication.
Use a genuine replacement reason. Do not invent an editorial defect to obtain evidence.
Keep the publication reserve separate from the reserve-exhaustion test.
Prepare a concrete stop procedure before publication approval. An ambiguous result does not permit a retry.
Continued publishing requires an explicit decision. Publication approval does not start the review period.

### Local proof-policy check — 2026-09-22

Ran these existing suites with synthetic inputs:

- `tests/reserve-policy.test.ts`: 12 passed.
- `tests/review-policy.test.ts`: 20 passed.
- `tests/delivery-eligibility.test.ts`: 44 passed.

All 76 tests passed. The command used an empty inherited environment, except PATH and HOME.
The macOS sandbox denied network access. No database command, model call, or renderer ran.

The tests cover reserve ordering, empty pools, continuous-range feedback, four-part identity checks, and delivery refusal after edits.
They also cover QC mismatches, the publishing switch, human acceptance, and required church approval.
They do not prove transactional replacement, live census completeness, final media quality, or publication.
No operational proof changes from MISSING to PASSED because of these results.

### Preserved scope limits

No new model adapter, automatic selection expansion, or duplicate prevention is required by this execution record.
Resolve duration support only if the fresh pool cannot supply suitable complete clips through supported editing.
Keep the complete-message policy disabled. Absence or explicit false preserves the existing analysis path.
Preserve the original demo hold, saved edits, approvals, review history, and continuous source ranges.
Keep PR #106 in draft and this file uncommitted. No current remote PR state was checked.
No production access, media processing, rendering, deployment, merge, or external model call occurred during this review.
