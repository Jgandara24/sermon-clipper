# Plan: production settings for the lab steps

Date: 2026-10-31. Status: Jake accepted the five decisions in section 5 on 2026-10-31, and the code was built the same day on branch `claude/selection-steps-settings` from `main`, draft pull request #124 (section 7 lists where the build differs from the plan). This is item 2 of section 9 in [PHASE1_LAB_RESULT.md](PHASE1_LAB_RESULT.md).

## 1. What is true today

The lab steps are on `main` since pull request #120 (merge `54c4c53`, live on 2026-10-31). Every step asks `labStepEnabled(step)` in `src/lib/lab-flags.ts`. That function returns false whenever `NODE_ENV` is `production`, and otherwise reads one `LAB_*_ENABLED` variable. So production cannot turn a step on, by design.

Eight places ask it:

| Step | Where | Side | Fails |
|---|---|---|---|
| `sermonSpan` | `src/lib/analysis/lab-selection-run.ts` | analyze | open |
| `boundaryStep` | same | analyze | open |
| `dropoutCheck` | same | analyze | open (the scan); a found dropout rejects the clip |
| `cameraCheck` | same | analyze | closed: a clip nobody could check is not a first pick |
| `agreementRanking` | same, `runAgreementRanking` | analyze | open |
| `phraseCaptions` | `src/lib/exports/handler.ts` | export | open (the loudness check); the caption style itself is a product change |
| `speakerTracking` | `src/lib/exports/handler.ts` | export | open: the clip renders with the fixed crop |
| `transcriptReuse` | `src/lib/transcription/lab-transcript-reuse.ts` | transcribe | lab only, stays lab only |

Two steps need a Python runtime with OpenCV and the YuNet model: the camera check (`scripts/lab/tracking/camera-sample.py` and `observe-people.py`) and speaker tracking (`observe-faces.py`). Both call `labTrackingPython()`, whose default is a path on Jake's Mac. `Dockerfile.worker` has no Python. That is item 3 of the result document; this plan only defines the setting for it.

The code base already has three settings patterns:

1. **Environment flags** in `src/lib/env.ts`, parsed with `exactTrue`: only the exact string `true` turns them on. `AUTOMATIC_PUBLISHING_ENABLED`, `AUTOMATIC_SCHEDULE_ARMING_ENABLED` and `SOURCE_RETENTION_DELETION_ENABLED` work this way, and `docs/DEPLOYMENT.md` documents each one.
2. **Workspace settings** in the `Workspace.settings` JSON column, read by typed readers in `src/lib/workspace-settings.ts` (the church profile, the Facebook connection).
3. **Versioned policies** in a table, drafted and activated by an operator script: `AnalysisRoutingPolicy` with `npm run set:analysis-routing`, and a snapshot recorded on each analyze job.

`labStepEnabled` was kept out of `env.ts` on purpose: four tests replace that module wholesale, and a lab switch had to read as off there instead of throwing.

## 2. The design: two gates and one resolver

A step runs only when two gates agree. The **environment gate** says the environment can run the step. The **workspace gate** says this church gets it. Both default to off, so a deploy changes nothing until an operator sets both.

### 2.1 Environment gate, in `src/lib/env.ts`

Seven `exactTrue` variables, one per step, named for what they do and not for the lab:

| Variable | Replaces |
|---|---|
| `ANALYSIS_SERMON_SPAN_ENABLED` | `LAB_SERMON_SPAN_ENABLED` |
| `ANALYSIS_BOUNDARY_STEP_ENABLED` | `LAB_BOUNDARY_STEP_ENABLED` |
| `ANALYSIS_DROPOUT_CHECK_ENABLED` | `LAB_DROPOUT_CHECK_ENABLED` |
| `ANALYSIS_CAMERA_CHECK_ENABLED` | `LAB_CAMERA_CHECK_ENABLED` |
| `ANALYSIS_AGREEMENT_RANKING_ENABLED` | `LAB_AGREEMENT_RANKING_ENABLED` |
| `EXPORT_PHRASE_CAPTIONS_ENABLED` | `LAB_PHRASE_CAPTIONS_ENABLED` |
| `EXPORT_SPEAKER_TRACKING_ENABLED` | `LAB_SPEAKER_TRACKING_ENABLED` |

Plus one path: `DETECTOR_PYTHON`, the Python with OpenCV and YuNet, replacing `LAB_TRACKING_PYTHON`. It has no default. When it is absent or does not run, the camera check and speaker tracking count as off, and the worker records one `selection_steps_unavailable` event with severity `error` at boot. That turns a missing runtime into one alert instead of one failed clip at a time.

`LAB_TRANSCRIPT_REUSE_ENABLED` stays as it is, in `lab-flags.ts`, which shrinks to that one switch. Production never reads it.

### 2.2 Workspace gate, in `Workspace.settings`

One JSON key, `selectionSteps`, read by a typed reader next to the church profile:

```json
{ "selectionSteps": { "sermonSpan": true, "boundaryStep": true, "dropoutCheck": true, "cameraCheck": true, "agreementRanking": true, "phraseCaptions": true, "speakerTracking": false } }
```

A missing key or a missing step means off. Unknown keys are ignored. Phrase captions sit here too, because capital letters without punctuation are a visible change for a church.

An operator script sets it, in the style of `set:analysis-routing`:

```
npm run set:selection-steps -- --workspace <id> --on sermonSpan,boundaryStep,dropoutCheck,cameraCheck,agreementRanking,phraseCaptions
npm run set:selection-steps -- --workspace <id> --off speakerTracking
npm run set:selection-steps -- --workspace <id> --show
```

No settings page for now. Jake is the only operator, and a page is more code than the lab asked for.

### 2.3 The resolver, `src/lib/analysis/selection-steps.ts`

One pure function, `resolveSelectionSteps({ environment, workspaceSettings, detectorPython })`, returns one object with a boolean per step and the reason each one is off: `environment`, `workspace`, `no-detector`. It runs once per ANALYZE job and once per EXPORT job. It does not look at `NODE_ENV`; that special case is what made production unreachable, and it goes away.

Both handlers record the resolved object in the operational event they already write (`lab_selection_steps`, and the export's render event). Each job then states which steps it ran with, the way the analyze job records its routing snapshot today.

`runLabSelection` and `runAgreementRanking` take the resolved steps as a parameter instead of asking `labStepEnabled`. The export handler does the same for phrase captions and speaker tracking. The fail-open and fail-closed behaviour inside each step does not change.

### 2.4 Alerts on the operational events

Today `dispatchOperationalAlertSafely` emails only events with severity `error`, throttled. Single step failures stay `warning`, as now: one clip with a fixed crop or one boundary call that failed is not an incident. Two new `error` events, each at most once per job:

- `selection_steps_degraded`: a fail-open step failed for every clip of one project, or the camera check could check no clip at all. The church still gets clips, but not the ones the settings promised.
- `selection_steps_unavailable`: a step is on in both gates and cannot run, such as a missing `DETECTOR_PYTHON`, recorded at worker boot and again on the first job that hits it.

The event names keep their `lab_` prefix for the steps themselves. The lab's reporting and the `lab:replay` gate read those names, and renaming buys nothing.

### 2.5 The lab keeps working

`npm run lab:worker` sets the seven new variables and `DETECTOR_PYTHON` instead of the `LAB_*` names. The lab workspace gets every step on once, with `set:selection-steps` against the lab database. The lab's own switch, transcript reuse, is untouched.

## 3. Files and size

| File | Change |
|---|---|
| `src/lib/env.ts` | 7 `exactTrue` flags, `DETECTOR_PYTHON`, comments in the house style |
| `src/lib/analysis/selection-steps.ts` | new: the resolver and its types, about 80 lines |
| `src/lib/workspace-settings.ts` | the `selectionSteps` reader |
| `src/lib/analysis/lab-selection-run.ts` | takes the resolved steps; no `labStepEnabled` |
| `src/lib/jobs/handlers/analyze.ts` | resolves once, passes the steps, records them |
| `src/lib/exports/handler.ts` | the same for the two export steps |
| `src/lib/analysis/camera-check-run.ts`, `src/lib/speaker-tracking/lab-observe.ts` | take the Python path as a parameter |
| `src/lib/lab-flags.ts` | shrinks to `transcriptReuse` |
| `src/worker/run-jobs.ts` | the boot check for `DETECTOR_PYTHON` |
| `scripts/set-selection-steps.ts`, `package.json` | the operator script, the new `lab:worker` variables |
| `docs/DEPLOYMENT.md` | the eight variables in the environment table, with the rollout order |
| `tests/` | resolver tests (both gates, the detector reason, unknown keys), handler tests for the recorded snapshot, the alert cases |

About 300 lines of code and tests, one session, plus one Linux run through CI. No migration: the workspace gate uses the existing JSON column.

## 4. Rollout, after the code lands (item 8 of the result document)

1. Deploy with every variable absent. Nothing changes.
2. Set the five `ANALYSIS_*` variables and `EXPORT_PHRASE_CAPTIONS_ENABLED` to `true` on the Railway worker. Still nothing changes, because no workspace has the key.
3. Turn the steps on for the Sunnylane workspace with `set:selection-steps`.
4. Run the five lab sermons through production. Compare the clips with round 9 using the marks as the regression set; `npm run lab:replay` already replays stored candidates against them.
5. Widen to the next church only after that comparison.
6. Speaker tracking and the camera check wait for item 3, the Python runtime in the worker image. Until then `DETECTOR_PYTHON` is absent and both count as off, with one boot-time event saying so.

## 5. Decisions for Jake

1. **Two gates, or the environment gate alone.** Two gates are the only way to try Sunnylane first. The environment gate alone would turn a step on for every church at once.
2. **The variable names above.** They describe the step, not the lab. The lab names stay only in `lab:worker`'s history.
3. **Agreement ranking in the first production set.** It doubles the Stage A and B cost, about $0.22 per sermon, and 53 of 54 agreed clips passed. I would include it.
4. **Phrase captions as a workspace setting.** A church sees them. I would gate them per workspace, as planned here.
5. **A missing detector runtime counts as off, with one alert.** The alternative is to fail the job. I would not fail a church's sermon over a missing Python.

## 6. What this plan does not do

- It does not meter the steps' model calls in the cost facts. That is item 5.
- It does not put Python, OpenCV or YuNet in the worker image. That is item 3.
- It does not add a settings page.
- It does not change any prompt, threshold or edge rule. The lab code stays as Jake froze it on 2026-10-31.

## 7. As built, 2026-10-31

The build follows sections 2 to 4. These are the places where it differs, and why.

- **The workspace reader lives with the resolver.** `parseSelectionStepsSettings` is in `src/lib/analysis/selection-steps.ts`, not `src/lib/workspace-settings.ts`, so the resolver can take the raw `Workspace.settings` without a circular import. The operator script imports it from there.
- **A broken detector counts as off, not only a missing one.** `availableDetectorPython` runs `import cv2` under `DETECTOR_PYTHON` once per job and hands the resolver the path only when that works. The worker's boot check, `checkDetectorRuntime`, runs the same probe and records `selection_steps_unavailable` with status `missing` or `broken`.
- **Degraded is computed by the steps and recorded by the job.** `runAgreementRanking` and `runLabSelection` return `{ clips, degraded }`. ANALYZE records one `selection_steps_degraded` event when the list is not empty. A step is degraded when the sermon span or the dropout scan failed (one call per project), when the boundary step failed for every clip it tried, or when the camera check could check no clip. One failed clip among others stays a line in the step's own event.
- **Where the snapshot goes.** ANALYZE stores the resolved steps in its job metadata as `selectionSteps` and on the `lab_selection_steps` and `lab_agreement_ranking` events. EXPORT writes no event on success, so the snapshot rides on the four lab events it already writes: `lab_speaker_tracking`, `lab_speaker_tracking_failed`, `lab_caption_cleanup` and `lab_caption_cleanup_failed`.
- **`npm run lab:replay` sets `DETECTOR_PYTHON` too.** Fixes Y and AC run the detector, and the replay script refuses to start them without the path.
- **Two timeouts keep their lab names.** `LAB_CAMERA_CHECK_TIMEOUT_MS` and `LAB_TRACKING_TIMEOUT_MS` are unchanged; renaming them was not in the plan.
- **The operator script accepts `--on` and `--off` together,** and refuses a step named in both. `--off` stores `false` rather than deleting the key, so a later `--show` says what was decided.
