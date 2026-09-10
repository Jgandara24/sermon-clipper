# P2 isolated release rehearsal

This harness uses synthetic fixtures. It does not use production data or settings.
Keep PR #106 in draft until the separate release review is complete.

## Commands

Stage A prepares files only:

    node --import tsx scripts/prepare-release-rehearsal.ts --prepare

The separately authorized local rehearsal creates its own Postgres cluster,
databases, fixture objects, workers, and native Next.js fixture hosts:

    node --import tsx scripts/rehearse-release.ts --local

Focused reruns create fresh resources. They never resume or overwrite an old run:

    node --import tsx scripts/rehearse-release.ts --local --case migrations
    node --import tsx scripts/rehearse-release.ts --local --case contracts

These commands require macOS, /usr/bin/sandbox-exec, installed local dependencies,
and PostgreSQL 17 at /usr/local/opt/postgresql@17/bin. There is no unsandboxed fallback.
They never connect to the existing local Postgres instance. No deployment command runs.
The local command cannot enable remote storage tests.

## Pinned inputs and build limits

- Baseline: 1d77d399a10ab70591974c3a8b4dc110a34e4109, with 26 migrations.
- Candidate: 65aab9e77e460777b0600657edfdad65ca940d1d, with 28 migrations.

These inputs do not establish the current production revision. A changed application
candidate needs new evidence. Rehearsal-only commits do not change these input refs.

The exporter reads committed blobs. It excludes environments, recordings, private
directories, and unrelated working files. It retains media helper source code.
It refuses selected symlinks and special files. Git transports and lazy fetching are disabled.

The exports share installed dependencies only after lockfile and package version checks.
No clean dependency install is claimed. Each export receives its own generated Prisma
client. Generator output and native engine targets change in a separate schema copy.
Migration SQL stays intact.

The worker bundle executes the pinned loop, queue, heartbeat, and job runner.
Media readiness, paid handlers, and external periodic effects use recorded fixture
boundaries. The native Next.js fixture host executes the pinned project action and
its real after() callback. Authentication and project creation are fixture boundaries.
The server action directive is removed for direct route invocation. Callback and runner
logic remain present.

Every replacement and bundle has a hash in rehearsal-build/instrumentation.json.
The small fixture host is not the complete production application or Linux image.
Its result does not prove Railway termination settings, replicas, or deployment behavior.

## Isolation and ownership

The OS profile denies network access except the generated local fixture ports.
Before startup, probes require OS denial for a documentation-only external address,
a child process using that address, and an unlisted local port. A timeout is not proof.
Postgres and host connections prove the allowed local path separately.

Child environments use an allowlist. They inherit no database URL, credentials,
proxy, loader flag, or SDK endpoint. HOME and temporary paths belong to the run.
An explicit locale avoids a macOS Postgres startup failure.

Postgres uses a newly initialized data directory and generated loopback port.
Unix sockets are disabled. Its reported data directory must match the owned directory.
Database creation never uses IF NOT EXISTS. Restore accepts only an untouched database
created by the same controller. Failed restore targets cannot be reused.
Database URLs reject hostnames, routing overrides, and wrong names.

Processes run in owned groups. The controller records actual exits and refuses restart
after closure. A signal is not proof of exit. On a macOS group-signal teardown race,
only an observed child close can resolve the race. Other signal errors remain failures.

## Local cases

| Area | Evidence |
| --- | --- |
| Shutdown | Both versions; worker and native web host; idle, released job, forced stop |
| Intake/restart | Closed intake refuses requests; closed controller refuses restart |
| Migration gate | Active executors block the stopped-state check; old builds refuse candidate schema |
| Queue history | Completed, interrupted, successor, and future retry states remain recorded |
| Quiet interval | No process group or new claim remains for more than two polling intervals |
| Backup/restore | Custom archive, hash, data, constraints, table counts, migration history |
| Restore refusal | Populated destination and truncated archive both fail |
| Migration | Both migrations complete; legacy IDs and edits remain; revision baselines equal zero |
| Migration failure | Lock timeout, inspected failed state, supported resolve, successful retry |
| Partial chain | Stop at 27 migrations, then resume to 28 without changing checksums |
| Baseline rollback | Restore a baseline archive into fresh databases; start baseline worker/web builds |
| Candidate recovery | Preserve revisions and journals; recover an interrupted job; restart candidate |
| Application contracts | Pinned source-copy and transcription handoff tests with synthetic inputs |

The forced-stop grace is ten seconds. It is a fixture value, not a production setting.
The migration interruption is between migrations, not a mid-statement kill.
Candidate restart is recovery evidence. No older compatible rollback build is selected.
Small backup times are not production recovery-time or recovery-point guarantees.
Synthetic approvals, captions, and exports are not human P2 acceptance.

## Evidence and cleanup

Each run uses a new OS temporary directory. It contains pinned exports, source hashes,
fixtures, ownership records, archives, build patches, process results, claim events,
database snapshots, and local-results.json. Focused runs label their narrower scope.

The controller drops only databases it created, stops the owned cluster, and removes
its data directory. Recorded fixture objects are removed only after database references
are gone and paths and hashes match. Evidence and build exports remain for review.
Temporary output is not durable release evidence. Interrupted runs retain ownership
records for exact-resource recovery.

## Remote disposable storage: separate approval

Remote tests remain blocked until the operator supplies a new private bucket,
bucket-restricted credentials, current price evidence, and an approved dollar limit.
The harness does not create a bucket or infer approval from credentials.

After review, use a private regular JSON file with mode 0600:

    node --import tsx scripts/rehearse-remote-storage.ts --approved-config /absolute/path/to/private-config.json

Required fields: bucket, provider (aws or r2), region, accessKeyId, secretAccessKey,
maxUsd, worstCaseUsd, priceEvidenceUrl, approvedNewPrivateBucket: true, and
approvedBucketScopedCredentials: true. R2 also needs its account endpoint.
Bucket names must match p2-rehearsal-<32 lowercase hexadecimal characters>.

Review credential scope and prices before execution. Config attestations do not prove
IAM scope. AWS tests also require all bucket public-access blocks and an unversioned
bucket. R2 public-domain settings need separate review. The bucket must be empty.
The client uses explicit credentials and no retries.

Limits: 12 objects, 32 MiB written, 100 requests, and 15 minutes.
Twelve requests are reserved for exact-key cleanup. These limits support a reviewed
cost estimate; they are not provider billing controls. Interrupted cleanup needs review.

The shared contract checks byte identity, existing-destination refusal, concurrent
conditional copies, changed-source refusal, and bounded reads.
Cleanup verifies ownership metadata and uses an ETag condition. It never sweeps a bucket.
Registration, uncertain responses, and transaction recovery have separate local tests.
Do not label those tests as remote database proof. Private results are written beside
the reviewed config without secret keys.

## Validation and release limits

    npx vitest run tests/release-rehearsal.test.ts tests/rehearsal-runtime.test.ts tests/rehearsal-storage-contract.test.ts
    npx tsc --noEmit

Regular CI runs unit tests, not the macOS rehearsal or remote command.
The local runtime preflight unit test is skipped on other operating systems.
Use saved execution evidence for host, database, and native Next.js checks.

Production still needs its own revision, backup, restore, shutdown, replica,
automatic deployment, maintenance-window, and rollback review.
No rehearsal result authorizes merge, deployment, real processing, publication,
hold changes, or the 30-day phase. Leave the P2 test plan and unrelated edits uncommitted.
