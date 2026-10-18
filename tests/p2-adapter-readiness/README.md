# P2 adapter readiness tests

These tests support the [live-adapter design](../../docs/P2_LIVE_ADAPTER_DESIGN.md).
They add no runtime code or live transport.
The application policy stays disabled. Enabled settings exist only inside disposable test objects.

## Scope

`dense.test.ts` constructs invented transcripts at 180 words per minute.
It checks whole-context packing, repeated context, input reservations, full responses, and refusal after mocked truncation.
It imports the real complete-message provider wrapper and scoring schema.
It injects mocked adapter responses and token meters.

The byte-based size model uses `ceil(UTF-8 bytes / 4)`.
It supplies test units only. It neither measures provider tokens nor establishes a safe upper bound.
Controlled low input counts isolate output packing in the ten-candidate test.
Scripted complete judgments establish no real meaning evidence.

`queued-export.test.ts` constructs synthetic queued jobs before changing their mocked project policy.
It calls the real export handler with mocked database, storage, filesystem, font, media, and cost services.
No media file is created, opened, probed, or rendered.
An in-memory string supplies synthetic checksum bytes.
These tests do not execute the enqueue route or prove database concurrency.

The tests characterize current behavior. They do not implement the proposed export policy snapshot.
Their passing legacy checks do not approve weakened QC for a future complete-message export.

## Results

The isolated run passed 127 tests across seven files.
The isolated TypeScript check passed.
The new files contain eight dense-request tests and twelve queued-export tests.
The configuration also selects existing mocked analysis, save, delivery, reanalysis, and transcription-hold tests.
Those tests retain protected work, approval invalidation, and exact-render identity checks.

Run from the repository root:

```sh
./node_modules/.bin/vitest run --config tests/p2-adapter-readiness/vitest.config.ts
./node_modules/.bin/tsc --project tests/p2-adapter-readiness/tsconfig.json
```

No production access, external model call, media processing, rendering, deployment, merge, or publication occurred.
No test loaded a real provider client.
The source comments and design describe the limits of each measurement.

## Preservation

Branch: `codex/p2-sandbox-preparation`. HEAD: `86d1691`.
The initial record contains 744 existing files outside the unrelated training directory.
Final checksum checks confirmed that all 744 files remain unchanged.
This task adds this folder and the adapter design only.
Application runtime code, prior stages, the Stage 5 checklist, and unrelated changes remain unchanged.
The Git index remains empty. The P2 plan remains untracked and uncommitted.
No PR or transcription-hold state changed. Remote states remain unchecked.

## Next step

Use the design's prompt for pure prepared-request and output-budget helpers.
Keep transport mocked, runtime wiring unchanged, and the policy disabled.
Real token calibration, database concurrency, source review, and final-render evidence remain pending.
