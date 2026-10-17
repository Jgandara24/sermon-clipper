# Registered region export checks

Range exports now check registered source regions before acquiring media and again after rendering.
Each check uses the pinned source checksum and final selected interval.
The check also verifies workspace ownership.
It uses half-open overlap, so touching endpoints do not overlap.

Only `SERMON` and `PASTOR_VISIBLE` facts permit export.
Slides, verse slideshows, forbidden service content, ambiguous facts, and unknown region kinds stop export.
The failure is terminal for that export job.
The worker does not trim approved edits or fall back to the original.
Boundary changes require a new reviewed edit and export request.

Successful render QC records the region-check checksum and matched-region count.
It explicitly states that detector coverage remains unproven.
No registered overlap does not prove that missing detectors found all forbidden content.

Export completion checks the regions again inside a transaction.
It takes the source lock that region registration also uses.
A region committed before that lock can prevent the job from becoming successful.
If the final check fails after upload, the output remains unattached to the failed job.
Existing orphan cleanup owns that unattached output.

The checks currently apply to pinned range exports.
Legacy original-input exports still need integration.
The publication checks and review exceptions below handle later evidence for pinned range exports.
Precise region detection and representative acceptance remain unfinished.

All 21 focused policy and job-state tests passed.
Three generated-media database cases passed: normal export, refusal before download, and refusal after late region registration.
The late-registration case left the export unfinished with no attached output.
Lint, type checking, and the worker build passed.

## Publication eligibility — 2026-10-16

The shared delivery loader now checks current regions for the exact pinned export.
It does not trust the region snapshot saved during rendering.
The delivery rule refuses forbidden regions or an unavailable check for a pinned range.
The global publishing switch and existing human-review requirements remain authoritative.
Legacy original-input exports keep their existing delivery behavior.

A region registered after successful export can now stop the next publication assessment.
The publisher records the standard ineligibility event and leaves the post queued.
No provider call follows that refused assessment.
This check does not retract a post that already exists.
Evidence can still change between assessment and the external provider call.
The following sections add transactional admission and review exceptions for later evidence.

All 58 delivery and publisher unit tests passed.
Three generated-media database cases passed after the delivery change.
The successful-export case verified that later region evidence changed delivery status from clear to blocked.
No external publication request ran.
Lint, type checking, and the worker build passed.

## Transactional range publication claim — 2026-10-16

The publisher now uses a separate transactional claim for pinned range exports.
The claim verifies the pinned workspace, clip, and successful export.
It locks the source before checking current regions.
Region registration uses the same source lock.
The transaction then claims the exact queued slot and records publication intent.
If intent creation fails, the slot claim also rolls back.
Concurrent workers cannot both claim the same slot.

A refused region check leaves the slot queued and creates no publication intent.
The publisher records the refusal and makes no provider call.
The external provider call occurs only after the transaction commits.
The review exceptions below record region changes after that commit.
The transaction does not lock the database during a network request.
Legacy publication keeps its existing claim path.

All 78 focused delivery and publisher tests passed.
Three database claim cases passed, including concurrent claims and injected intent failure.
Publisher tests verified zero provider calls after refusal or a lost claim.
Only injected providers ran; no external publication occurred.
Lint, type checking, and the worker build passed.

## Review exceptions after publication claim — 2026-10-16

Region registration now checks overlapping pinned publications with `IN_PROGRESS` or `SUCCEEDED` status.
Forbidden evidence creates a `SOURCE_REGION_CHANGED_AFTER_CLAIM` review exception.
The exception records the region identity, source checksum, interval, and publication snapshot.
Registration and exception creation share the source lock and transaction.
An exception failure rolls back region registration.

Repeated registration creates one exception for each affected post and region.
Repeated registration does not reopen a resolved exception for the same region.
A new region can create another exception.
Allowed regions, other source checksums, touching endpoints, and queued posts create no exception.
Publication status and remote identifiers remain unchanged.
This action does not retract posts or cancel provider requests that already started.

Ten database cases passed, including concurrent registration, rollback, exclusions, and publication claims.
All 21 focused policy and job-state tests passed.
The tests used simulated publication states and made no provider requests.
Type checks and lint passed.

## Original-file export checks — 2026-10-16

Original-file exports now check known regions before download and after rendering.
They retain the rendered source ID, interval, and edit version in QC evidence.
Completion checks that evidence against the saved edit and current source association.
Missing evidence or changed boundaries stop completion.
Completion checks regions while it holds the same source lock as region registration.
Concurrent cancellation still prevents a successful state transition.

Original-file exports lack a pinned source checksum.
Their checks therefore include all retained region identities for that source.
Old conflicting facts can stop an export until an operator resolves the source evidence.
Range exports continue to check their exact pinned checksum.
Neither check proves complete detector coverage.

These checks do not cover new facts that arrive after original-file export completion.
Original-file publication admission and late publication exceptions still need integration.
No production setting changed during this work.

All 34 focused unit tests and nine selected database cases passed.
Database cases covered forbidden facts before rendering, during rendering, and before completion.
They also covered missing evidence, changed boundaries, successful original exports, and existing range exports.
Lint, type checking, and the worker build passed.
Tests used generated media and temporary databases without external provider requests.

## Original-file publication checks — 2026-10-16

Publication now requires a clear region check for original and range exports.
The delivery loader reads original boundaries from render QC evidence.
It does not infer missing boundaries from the current clip.
Historical original exports without this evidence require a new render.
Original checks include all retained source identities; range checks retain their exact checksum scope.

`claimSourcePublication` checks regions, claims the exact slot, and records intent in one transaction.
It takes the source lock before the final region check.
An intent failure rolls back the claim.
Two concurrent workers can create only one claim and intent.
The publisher calls the external provider only after this transaction commits.

New forbidden facts create review exceptions for affected original publications already in progress or completed.
The exception keeps the publication status and remote post ID unchanged.
The same fact does not reopen a resolved exception.
Original render intervals use half-open overlap checks.
Missing historical boundary evidence creates a review exception when the current source association matches.
The system takes no remote retraction action.

Detector coverage, production activation, and human acceptance remain separate requirements.

All 83 focused unit tests and 76 database cases passed.
Database cases covered concurrent claims, rollback, missing evidence, late exceptions, and non-overlapping intervals.
The publisher and editorial-program regression suites used injected provider calls.
Lint, type checking, and the worker build passed.
No real provider request or production activation occurred.
