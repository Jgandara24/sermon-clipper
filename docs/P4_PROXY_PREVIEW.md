# Registered proxy playback

Candidate pages use the shared proxy when `P4_SERMON_PREPARATION_ENABLED` is exactly `true`.
The church page and operator page share `sourcePreviewUrl`.
The caller authorizes project access before requesting the URL.
The helper selects a ready, undeleted, unexpired `SOURCE_PROXY` from the source registry.
It requires `analysis-audio-proxy-v2` and a zero source start.
Original deletion does not prevent proxy selection.
A missing proxy returns no preview instead of silently using the original.
The disabled path keeps existing original playback.

The signed link contains a logical registry reference.
It does not place an arbitrary artifact storage key inside the legacy workspace-key contract.
The artifact playback route verifies the signature and workspace ownership.
It checks artifact kind, version, start, expiry, publication state, storage identity, object identity, checksum metadata, and byte count.
It then signs remote playback or serves local byte ranges.
Link expiration cannot exceed artifact retention.
Local playback supports closed, open-ended, and suffix byte ranges.
The route does not update original dimensions or legacy storage keys.

Storage identity checks detect changes before playback starts.
They do not provide an atomic guarantee against external replacement after those checks.
Artifact cleanup can also interrupt playback after its retention deadline.
Playback transfer accounting and browser acceptance remain unfinished.
This change does not enable production preparation.

All 22 focused preview and signing tests passed.
Lint, type checking, and the worker build passed.
Tests covered signed selection, original deletion, missing proxies, ownership filters, storage changes, remote signing, and local ranges.
These tests do not prove browser playback or production acceptance.

## Generated-media browser check — 2026-10-16

The isolated browser test generates four seconds of video and audio.
It publishes the real analysis derivatives through the source lease.
It deletes only its generated original and clears that fixture's original key.
Chromium opens the project page through a real authenticated session.
The test checks zero media requests before preview use.
Playback must use the registered 480p proxy and stop at the candidate boundary.
The test also checks unchanged original dimensions and zero export jobs.

Run `npx playwright test --config playwright.p4.config.ts` with an isolated migrated database.
Set `P4_BROWSER_TEST=1`, `P4_BROWSER_ROOT`, `P4_SERMON_PREPARATION_ENABLED=true`, and isolated local storage.
The dedicated configuration starts its own server on port 3219.
It never reuses an existing server.
The fixture uses the database supplied by `DATABASE_URL`.
The caller must remove the disposable database and storage after the test.
This check does not prove remote storage playback or production deletion policy.

The Chromium test passed for both church and operator pages.
The operator used a separate workspace and received the source owner's signed proxy reference.
Both paths returned HTTP 206, played 480p video, and stopped at the candidate boundary.
Lint and type checking passed.
The test harness stopped its server and database, then removed its generated files.
