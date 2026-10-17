# PERC retrieval and deletion experiment

Plan item 20 requires a separate proof that a PERC recording can be retrieved and deleted.
PERC means a church's streaming platform pushes a copy to a Cloudflare Stream live input.
Cloudflare records the stream and can expose an MP4 download.
No PERC code existed before this work.

## Prior evidence

`DECISIONS.md` (2026-07-23 and 2026-08-11) records that automated PERC retrieval never worked end to end.
Pulpit Engine's `00_START_HERE/current-build-status.md` records its only real recording.
A dry-run check found `download_status = null` and no MP4 URL; a person then supplied the URL by hand.
Cloudflare documents MP4 downloads as created on request with `POST /stream/{uid}/downloads`.
The likely cause is therefore a missing download request, not a broken recording.
This experiment tests that explanation; it does not assume it.

Sermon Clipper must use its own Cloudflare account, not Pulpit Engine's.
This work read Pulpit Engine documentation only. It used no Pulpit Engine code, data, or credentials.
No Cloudflare Stream credentials exist in this repository or its local environment.

## API facts used

Checked against Cloudflare documentation on 2026-10-16:

- `POST /accounts/{account}/stream/live_inputs` creates a live input. `recording.mode: "automatic"` records it.
- `deleteRecordingAfterDays` accepts 30 to 1096 days.
- A recording is available within about 60 seconds after the stream ends.
- `GET /stream/live_inputs/{input}/videos` lists recordings; `status.state` becomes `ready`.
- `POST /stream/{video}/downloads` creates the default MP4. `GET` reports `inprogress` or `ready`, `percentComplete`, and `url`.
- `DELETE /stream/{video}` deletes a video. The documentation does not say whether this removes its MP4.
- Storage costs $5 per 1,000 minutes per month. Delivery, including MP4 downloads, costs $1 per 1,000 minutes.
- Ingest and encoding are free.

## Design

`scripts/perc-experiment.ts` runs nine steps against a synthetic feed:

1. Verify the API token.
2. Create one live input with automatic recording and a 30-day deletion safety net.
3. Push 90 seconds of ffmpeg test video and a 440 Hz tone over RTMPS.
4. Poll until exactly one recording is ready.
5. Create the MP4 download explicitly and poll until it is ready.
6. Download it with a 512 MiB limit; record its SHA-256, duration, dimensions, and audio.
7. Delete the local copy, the recording, and the live input; poll until each reports HTTP 404.
8. Poll until the former MP4 URL stops serving the file.
9. Write `report.json`.

Deletion runs after any failure for every resource the run created.
Unconfirmed deletions appear in `residualResources`, and the conclusion becomes `FAILED`.
The report never contains the API token, stream key, or MP4 URL.
API errors keep only the HTTP status and numeric codes.
The stream key is visible to local process listings while ffmpeg runs.

The command plans by default and contacts nothing.
Execution requires `--execute`, `--confirm-account-owner sermon-clipper`, and a new `--output` directory.
It validates `PERC_CF_ACCOUNT_ID` and `PERC_CF_API_TOKEN` before creating anything.
The token needs only Stream Read and Stream Write permissions.

```bash
npx tsx scripts/perc-experiment.ts --execute --confirm-account-owner sermon-clipper --output <new-directory>
```

The estimated cost of one 90-second run is below $0.01 at the published prices.
A Stream subscription on the account may carry its own minimum charge.

## Verification

Eleven unit tests passed with a simulated Stream API.
They cover the complete run, the explicit download request, a download timeout, unconfirmed deletion, a duration mismatch, and a failed push.
They also cover request construction, credential validation, error redaction, and the 404 rule.
The plan mode and three refusal paths passed without network access.
Refusals created no output directory.
The synthetic feed's ffmpeg arguments produced 1280×720 H.264 and AAC in a local file.
Lint and type checking passed.

## First real run — 2026-10-16

Jake approved one run on a Sermon Clipper-owned Cloudflare account.
The token had only Stream Read and Stream Edit permissions.
The [retained report](../evaluation/p4-perc-experiment-2026-10-16-run1.json) contains no token, stream key, or download URL.

| Step | Outcome |
|---|---|
| Verify token | Passed; status `active` |
| Create live input | Passed; automatic recording |
| Push synthetic feed | Failed after 2518 ms |
| Recording, MP4, verification | Skipped |
| Delete live input and confirm absence | Passed; HTTP 404 on the first check |

ffmpeg 6.0 with GnuTLS completed the TLS connection to the RTMPS endpoint.
Cloudflare then closed the connection; ffmpeg reported a broken pipe.
ffmpeg logged no RTMP server status at its error level, so the cause is not proven.
No recording existed, so no video or MP4 needed deletion.
`residualResources` is empty.

Retrieval and deletion of a recording therefore remain unproven.
The run did prove token scope, live-input creation, and live-input deletion with absence confirmation.

The push step now logs verbose ffmpeg output with the stream key redacted.
A second run needs Jake's approval.

### Account inspection after the run

A read-only dashboard check of the experiment's account found two facts.
Stream storage showed 1,050 of 1,000 minutes used.
A full storage quota is the most likely reason Cloudflare refused the new recording; this is not yet confirmed by a server message.
The account also holds 19 existing Pulpit Engine PERC test recordings.
The account is therefore shared with Pulpit Engine, contrary to the 2026-07-23 isolation decision.
The run created and deleted only its own live input; it did not read, change, or delete existing videos.
Jake then decided to share this account between the two products (DECISIONS.md, 2026-10-16).
At his instruction, the 19 old recordings were deleted through the API; each returned HTTP 404 afterward.
The existing Pulpit Engine live input was kept.

## Second real run — 2026-10-16

The second run proved retrieval and deletion on the synthetic feed.
The [retained report](../evaluation/p4-perc-experiment-2026-10-16-run2.json) contains no token, stream key, or download URL.

| Step | Result |
|---|---|
| Push | 90 seconds; 90733 ms |
| Recording ready | 30938 ms after the push ended; exactly one recording |
| MP4 download | Created explicitly; `inprogress`, then `ready` after 15366 ms |
| MP4 file | 28546140 bytes; 88.067 s; 1280×720; audio present |
| Recording deleted | HTTP 404 on the first check |
| MP4 download record deleted | HTTP 404 on the first check |
| Former MP4 URL | Stopped serving after 46884 ms and four checks |
| Live input deleted | HTTP 404 on the first check |

Cloudflare reported 88 s of recording for 90 s of pushed feed.
The downloaded file agreed with Cloudflare's duration within 0.1 s.
The estimated cost was $0.0075 for one month of storage and $0.0015 for delivery; this is an estimate, not an invoice.
`residualResources` is empty.

The explicit `POST /stream/{video}/downloads` request produced a ready MP4 in about 15 seconds.
This supports the explanation for Pulpit Engine's earlier `download_status = null` result.

The run found one client defect.
The video `DELETE` returned HTTP 200 without the usual JSON envelope, and the client reported a failure.
The absence checks still confirmed deletion.
The client now accepts a successful bodyless `DELETE`; a new test covers this, and all 11 tests pass.

## What a real run cannot prove

A synthetic feed does not represent church encoders, long services, or interrupted streams.
One run does not measure reliability or real monthly cost.
It does not prove church onboarding or production intake code.
Production PERC intake remains unimplemented.
