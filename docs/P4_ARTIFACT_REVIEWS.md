# Recorded artifact reviews

`recordArtifactReview()` now records review decisions for candidate ranges.
It does not perform a comparison or infer approval.
The caller must authenticate the reviewer before calling this internal function.
No production route or review interface invokes it yet.

## Review evidence

Each immutable review records its reviewer, revision, decision, comparison reference, notes, and timestamp.
The review binds to the source checksum, artifact checksum, and mapping evidence checksum.
Accepted reviews require affirmative full-range, dimensions, timing, and visual-quality checks.
Rejected reviews can record incomplete checks and explain the rejection.

The service permits workspace owners and active owner, admin, or approver members.
It locks authorization records during the transaction.
It also locks the source and artifact before appending a decision.
Unfinished source sessions prevent review changes.
Expected revisions prevent stale decisions from replacing newer decisions.

Review insertion and artifact quality updates occur in one transaction.
The database rejects review edits, review deletion, skipped revisions, mismatched bytes, and missing approval evidence.
Deferred checks require the current artifact quality to match its latest review.
Cleanup can still tombstone an expired artifact without inventing review evidence.

## Read protection

Range read leases now require a matching accepted review record.
A quality field alone cannot authorize a range read.
The read audit pins the review ID and revision.
Active reads block review changes until their source session settles.
Legacy accepted artifacts without review evidence remain unreadable through this path.

## Verification and limits

Forty-seven database tests passed.
The local database tests exercise simulated reviews only.
No production artifact received visual approval.
Tests verify authorization refusal, stale revisions, changed bytes, incomplete approval, immutable history, and direct quality-change refusal.
They also verify review refusal during active reads and read refusal after rejection.

The migration adds `media_artifact_reviews` and database guards.
Clean installation, populated upgrade, and repeated deployment checks use disposable local databases.
Production deployment, a review interface, actual human comparisons, and export-worker selection remain unfinished.

Clean installation, populated upgrade, and repeated deployment passed.
Lint, type checks, and the worker build passed.
