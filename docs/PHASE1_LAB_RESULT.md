# Phase 1 lab result

Date: 2026-10-31. Status: the lab code is final for now (Jake, 2026-10-31). Branch `claude/phase1-lab`, commit `500d847`.
This document closes the plan in [PHASE1_LAB_PLAN.md](PHASE1_LAB_PLAN.md). Words follow [CONTEXT.md](../CONTEXT.md).

## 1. Summary

The lab ran on Jake's Mac from 2026-10-17 to 2026-10-31. Jake marked 72 lab projects, 428 clips in all. The old picker scored 0 of 6 on the first sermon. The final code scores 28 of 30 on five sermons, and it did so twice: round "fix AA-AE" on 2026-10-28 and round "agreement order" on 2026-10-31. A repeat run of the same code between them scored 27 of 30.

The plan asked for 18 of 18 on three sermons. The lab did not reach a perfect round. It reached a steady 27 to 28 of 30 on five sermons, and Jake chose to stop there: "A massive majority of the clips are really good and worthy. I don't want to mess anything up beyond this point."

Two findings matter beyond the score. First, the candidate model proposes different moments on each run, so two runs of the same code share only about half of their clips. Second, the moments that two runs both find pass Jake's review almost every time: 53 of 54 across rounds 5, 7 and 9. The agreement ranking, the last change, puts those moments first.

## 2. What the lab is

Five Sunnylane sermons on YouTube: a normal Sunday, a Wednesday night, a revival, "Divine Certainties" and a Bible conference with a guest preacher. Each round runs all five through the worker and shows Jake a review sheet with six clips per sermon. Jake marks each clip pass or fail, with the test it failed:

| Test | Meaning |
|---|---|
| 1 | The start or the end is wrong |
| 2 | The video shows someone other than the preacher |
| 3 | The video shows a slide, song words or a logo |
| 4 | The clip is not engaging |

The marks live in `evaluation/lab-labels/<projectId>.json`, one file per lab project, 72 files in all. The lab database is `pulpit_engine_lab` on Homebrew Postgres, the storage root is `/Users/jakegandara/pulpit-engine-lab/storage`, and production was never touched: every lab switch reads as off when `NODE_ENV` is `production`.

## 3. The score over time

| Marked | Round | Score |
|---|---|---|
| 2026-10-17 | old picker, sermon 1 | 0/6 |
| 2026-10-18 | picker fix, sermon 1 | 0/6 |
| 2026-10-18 | tracking, camera check, boundary step | 1/6 |
| 2026-10-19 | whole sentences, questions, phrase captions | 13/18 |
| 2026-10-20 | whole ends, sermon only, capital captions | 16/24 |
| 2026-10-20 | calm tracking, clean captions | 18/24 |
| 2026-10-21 | fix K, 90-second rule | 27/29 |
| 2026-10-22 | fix N | 26/30 |
| 2026-10-23 | fixes O and Q | 27/30 |
| 2026-10-25 | fixes T, U and V | 28/30 |
| 2026-10-26 | fixes W, X and Y | 20/30 |
| 2026-10-26 | fixes R and S | 27/30 |
| 2026-10-27 | fix Z | 25/30 |
| 2026-10-28 | fixes AA to AE (round 5, the reference) | 28/30 |
| 2026-10-28 | fixes AF to AH (round 6, reverted) | 3/3 marked, then stopped |
| 2026-10-30 | repeat of round 5, no code change (round 7) | 27/30 |
| 2026-10-31 | agreement order (round 9) | 28/30 |

The first runs of sermons 2 to 5, which scored 2 to 5 of 6 each, are left out of the table.

Round 6 was reverted on Jake's judgement before he finished marking. The analysis showed that its three fixes had not fired on any clip; the 20 new clips came from run-to-run variation in the candidate model. Round 8 ran the agreement ranking, but a re-sort inside the boundary step lost the agreement order. Commit `2aff682` fixed that, and round 9 ran on the fixed code. Round 8 was not marked.

## 4. What the final code does

The analyze job builds candidate windows from the transcript, asks the model to classify and score them (Stage A on `claude-haiku-4-5`, Stage B on `claude-sonnet-5`), refines and dedupes them, and keeps the top 18. Those steps run in production today, with the changes listed in section 7.

Behind lab switches, in `src/lib/analysis/lab-selection-run.ts` and the export handler, the lab adds:

| Switch | Step | What it does |
|---|---|---|
| `LAB_AGREEMENT_RANKING_ENABLED` | Agreement ranking | Asks for the candidates a second time. Moments both runs found come first; each group keeps its score order. Two clips are the same moment when they share more than half of the longer one. |
| `LAB_SERMON_SPAN_ENABLED` | Sermon span | Finds where the sermon starts and ends; drops clips outside it. |
| `LAB_BOUNDARY_STEP_ENABLED` | Boundary step | Moves each of the top 12 clips to whole sentences where its thought starts and lands. Includes one look past the end, the story check, the end snap into a pause, and the 30 to 60 second target with a 90-second cap. The prompt carries Jake's worked examples and the hook-and-closing rule. |
| `LAB_DROPOUT_CHECK_ENABLED` | Audio dropout check | Rejects a clip whose sound the recording lost for a second or more. |
| `LAB_CAMERA_CHECK_ENABLED` | Camera check | Samples frames, finds faceless stretches, and asks `claude-haiku-4-5` whether they show a slide. Walks the clips in rank order until six pass. |
| `LAB_SPEAKER_TRACKING_ENABLED` | Speaker tracking (export) | Runs a YuNet face observer in Python over the clip and builds a crop that follows the preacher. |
| `LAB_PHRASE_CAPTIONS_ENABLED` | Phrase captions (export) | One whole phrase per caption line, in capital letters, without punctuation. |
| `LAB_TRANSCRIPT_REUSE_ENABLED` | Transcript reuse | Lab only. Copies an earlier lab transcript of the same video instead of paying the provider again. |

Every lab step fails open except the camera check, which fails closed: a clip nobody could check is not a first pick. Each step records one operational event with its decisions and token counts.

## 5. What the marks show

**Run-to-run variation is large.** Rounds 5 and 7 ran the same code. Only 16 of their 30 sheet clips shared a moment, and only 6 had the same edges. The candidate model proposes different windows each run.

**Agreed moments pass.** Across rounds 5 and 7, every sheet clip whose moment both runs found passed, 35 of 35, and all 5 fails were moments only one run found. In round 9, 19 sheet clips came from agreed moments: 18 passed and 1 failed on its end line. The 11 single-run clips had 10 passes and 1 fail.

**Jake's marks are consistent.** In round 9, 17 of the 30 sheet clips repeated a moment he had marked in round 5 or 7. All 28 matched pairs carry the same verdict.

**The remaining fails are end lines.** Five of the seven fails in rounds 5, 7 and 9 are test 1, the start or the end. The notes say "Should have ended with..." or "it stop abrupt." Section 6 covers the two that share a cause.

## 6. The parked issue: the story check's landing

Both round-9 fails come from the story check (fix U, `checkStory` in `src/lib/analysis/boundary-step.ts`), which moves a clip cut from the middle of a story to where the story lands.

- **2r clip 6, 18:52 to 20:05.** The boundary step ended the clip on "And that man was killed that day for the gospel of Jesus Christ." The end look agreed. The story check then extended the end by 2.4 seconds onto "Now hear what's amazing." Its own reason called that line a new point. Jake's note: the second-to-last line was the right end.
- **4p clip 5, 45:29 to 46:28.** The story check found the landing at 46:41, "This is my beloved Son in whom I am well pleased. Hear him." The restart it wanted ran 80.4 seconds, over the 75-second limit, and was refused. The clip kept an end 12 seconds short of the landing, in the middle of the story. Round 5 produced the same clip to the millisecond (4l clip 3), and Jake failed it both times for the missing conclusion.

Across rounds 5, 7 and 9 the story check extended or restarted 9 sheet clips. Six ended at the landing it named: 5 passed, and 1 failed because the landing was the next opener. Three ended short of the landing: 2 failed (the same clip twice) and 1 passed, 5j clip 4, 8 seconds short.

The two fixes would be: the landing is never the first line of the next point, and a clip that cannot reach its landing goes behind the others. Jake parked them on 2026-10-31: "Maybe this can be noted and fixed later off if we still see issues." If a later round shows either sign again, build them and gate them on the stored boundary logs of rounds 5, 7 and 9. The gate must keep 5j clip 4 on its sheet.

## 7. Cost and time per sermon

Measured in round 9, list prices from the pricing table, transcript reused:

| Part | Model | Per sermon |
|---|---|---|
| Stage A classify | claude-haiku-4-5 | $0.09 to $0.10 |
| Stage B score | claude-sonnet-5 | $0.13 |
| Second candidate run (agreement) | both | $0.21 to $0.23 |
| Sermon span, boundary step, end look, story check | claude-sonnet-5 | $0.45 to $0.57 (131,000 to 167,000 input tokens) |
| Camera check | claude-haiku-4-5 | under $0.01 (5 to 16 frames) |
| **Model cost, all steps** | | **about $0.90 to $1.05** |

Production adds transcription, about 660 ElevenLabs credits per sermon, and compute for the renders and the speaker tracking. The Stage A and B costs are metered in `daily_cost_rollups`. The lab steps' tokens sit in operational events only, so a cost report undercounts a lab project by about $0.70 per sermon.

On the one lab worker, a round of five sermons with reused transcripts took 3 hours 3 minutes: the five analyses finished within 51 minutes, and the 30 renders with speaker tracking filled the rest.

## 8. Branch state

Branch `claude/phase1-lab` holds 88 commits that are not on `main`. Its base is `1d77d39` from 2026-09-09, and `main` on GitHub still ends there. The branch exists on GitHub, but the local copy is 21 commits ahead of it. Nothing on the branch is reviewed for production.

| Group | Commits | What |
|---|---|---|
| Lab code | 31 | The steps in section 4, their prompts and tests |
| Marks | 22 | Jake's verdicts, `evaluation/lab-labels` |
| Docs | 2 | Lab plan and decisions |
| Other, September | 19 | Whisper word reconstruction, sandbox slot preparation, transcript write locking, source copy and journal work |
| Other, October | 14 | P4 derivative-first media index and range exports, the Codex P2 complete-message policy, backup procedure docs; four of these say "(unreviewed)" in their subject |

The branch adds 19 Prisma migrations: 3 from September (source write boundary, source copy operations, cleanup journal) and 16 from the P4 work of 2026-10-16. None is from the lab itself. The lab changed `package.json` (lab scripts and switches) and did not change `package-lock.json`.

Six commits changed the always-on picker path, in `src/lib/jobs/handlers/analyze.ts` and `src/lib/analysis/pipeline.ts`, 180 lines added and 23 removed. After a merge these run in production with every switch off: Stage B spread across the whole service and rejection of non-preaching service parts (`c9d820e`), Stage B scores every window it receives (`3b3ca75`), Stage A reads an unknown moment type as reject (`733ec18`), every candidate window stays under 60 seconds (`56d50f7`), and the hooks for the lab steps (`a78d245`, `d7d7f81`), which do nothing while the switches are off.

In numbers, the branch adds 68,602 lines over `main` in 561 files: 19,545 in tests, 18,601 in marks, 15,007 in `src`, 8,470 in docs, 5,420 in scripts and 1,460 in Prisma. The lab's own code is about 5,800 lines in 37 files, with 4,300 lines of tests in 18 files.

## 9. What it would take to move the lab steps to production

The lab ran on Jake's Mac with a local Postgres, local storage, a Python environment at `/Users/jakegandara/ai-runtimes/p4-speaker-tracking-py313`, and switches that production ignores by design. Moving the steps needs the work below. Sizes are in sessions of work, not promises.

1. **Decide what moves.** Any merge of the branch carries the always-on picker changes in section 8. The flagged steps need a decision each. Suggested first set: sermon span, boundary step, dropout check, camera check and agreement ranking in the analyze job; phrase captions in exports. Speaker tracking is the hardest (item 3). Transcript reuse stays lab-only. Small.
2. **Turn the lab switches into production settings.** `labStepEnabled` in `src/lib/lab-flags.ts` returns false whenever `NODE_ENV` is `production`. Replace it with settings that production can read, per environment or per workspace, with every step off by default. Keep the fail-open and fail-closed behaviour and add alerts on the operational events. Small.
3. **Give the worker image what the steps need.** `Dockerfile.worker` has ffmpeg with libass, yt-dlp and whisper-cli. It has no Python, no OpenCV and no YuNet model. Speaker tracking calls `scripts/lab/tracking/observe-faces.py` through the Python at `LAB_TRACKING_PYTHON`, whose default is a path on Jake's Mac. Either bundle a Python runtime with OpenCV and the YuNet model into the image and test it on Linux, or ship the first production version with the existing static crop and add tracking later. Medium, and the main risk.
4. **Source files on the worker.** The camera check and the dropout check download the whole source video to a temporary folder for each analyze job. The export path already does this for renders, so the pattern exists, but the worker's disk and the storage egress need a check against the 15 GiB floor habit and the Railway volume. Small.
5. **Meter the new model calls.** Wire the boundary step, sermon span, camera check and second candidate run into the cost facts, so `report:project-cost` and the daily rollups see the extra $0.70 per sermon. Today those tokens live only in operational events. Small to medium.
6. **Review and merge the branch.** The 33 non-lab commits and the 19 migrations need their own review before they reach `main`; four commits are marked unreviewed. Two paths: review the whole branch and merge it, or cherry-pick the lab and picker commits onto `main` and leave the P4 and September work for later. Open a draft PR to get CI, since CI runs only on PRs. Watch the lockfile: an `npm install` on the Mac drops the `@emnapi` entries and breaks `npm ci` on Linux, so merge only the new subtree into `main`'s lockfile. Medium to large.
7. **Verify on Linux.** Run `npm run verify` (schema, lint, types, unit tests, build) and the integration suite on the merged tree, then build the worker image. The unit suite passes today: 233 files, 3,181 tests. Medium.
8. **Roll out behind the settings.** Deploy with every step off. Turn the steps on for Jake's workspace first and run the same five Sunnylane sermons. Compare the sheets with round 9 using the marks as the regression set; `npm run lab:replay` already replays stored candidates against the marks. Then widen. Small per step, spread over time.
9. **Expect the running cost.** Each sermon's analysis gains about four to five minutes and about $0.70 in model calls, and the second candidate run doubles the Stage A and B cost. A single worker processes sermons one at a time. Decide whether one worker is enough before the first church. Decision, not code.

Items 1, 2, 4, 5 and 8 are small and mostly inside the lab's own files. Items 3, 6 and 7 are where the time goes.

## 10. Where things are

- Code: branch `claude/phase1-lab`, commit `500d847`, nothing merged.
- Marks: `evaluation/lab-labels/`, 72 files.
- Lab steps: `src/lib/analysis/lab-selection-run.ts`, `src/lib/analysis/lab-selection.ts`, `src/lib/analysis/boundary-step.ts`, `src/lib/analysis/camera-check-run.ts`, `src/lib/analysis/audio-dropout.ts`, `src/lib/analysis/sermon-span.ts`, `src/lib/speaker-tracking/`, `src/lib/editor/phrase-caption-lines.ts`, `src/lib/transcription/lab-transcript-reuse.ts`.
- Lab tools: `npm run lab:worker`, `npm run lab:run`, `npm run lab:review`, `npm run lab:replay` in `scripts/lab/`.
- Lab data: database `pulpit_engine_lab`, storage `/Users/jakegandara/pulpit-engine-lab/storage`. Only rounds 5, 7, 8 and 9 still have their video files; the rest were deleted on 2026-10-29.
