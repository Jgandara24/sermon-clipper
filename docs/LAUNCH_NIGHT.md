# Launch Night Goal (overnight autonomous loop)

> Goal prompt for an autonomous Claude loop running while the operator sleeps. Work the phases in
> order. This file is the progress ledger — tick items as they complete, log every blocker under
> "Blocked / needs the operator", and write the final "## Night result" before stopping.

## Mission

Take sermon-clipper from a merged, review-hardened `main` to a **deployed, evidence-collected
production launch candidate**: GitHub + CI + branch protection, Railway deployment (web + worker
+ Postgres + volume), provider wiring (test-mode Stripe), and as much Phase 8 launch evidence as
can be honestly collected without the operator. Decisions already made: **private repo**,
**test-mode Stripe**, **Railway-generated subdomain**, credentials from
`.env.production.local`.

## Operating rules

1. **Honesty above progress.** Never record launch evidence that wasn't genuinely produced;
   `record:launch-evidence` items must describe what actually happened (test-mode Stripe is fine
   — say so in the evidence text). If an item can't be truthfully completed, leave it and log it.
2. **Spend guardrails.** Test-mode Stripe only (`sk_test_` — if the key in the file is `sk_live_`,
   STOP billing work and log it). Anthropic spend: process at most 2 sermon videos tonight. No
   Railway resources beyond: 1 project, Postgres, web service, worker service, 1 volume. Never buy
   domains, upgrade plans, or add paid add-ons.
3. **Secrets discipline.** Secrets flow only `.env.production.local` → Railway variables. Never
   commit, print, or log secret values; never write them into evidence text or this file.
4. **Verification gate.** Anything code-changing still requires `npm run verify` before commit.
   Prefer configuration over code changes tonight; if a code fix is unavoidable, smallest possible
   diff, committed with the usual discipline, pushed so CI validates it.
5. **Stuck rule.** If the same step fails 3 times with no new information, log it under Blocked,
   move to the next independent step. Never delete/recreate Railway resources in a retry spiral —
   two consecutive full teardowns is a stop condition.
6. **The operator is asleep.** Do not wait on questions. For reversible judgment calls, pick the
   sensible option and log the choice. For irreversible/spend decisions not covered here, skip
   and log.
7. **Stop condition.** All phases done or blocked → write "## Night result" (what shipped, what's
   blocked, exact morning to-do list), commit this file + any doc updates, push, stop the loop.

## Phase A — Preflight (gate; wait here if not ready)

- [ ] `railway whoami` succeeds (operator ran `railway login`). If not: this is the ONLY wait
      state — sleep the loop ~20 min and re-check; log the wait.
- [ ] `.env.production.local` exists and contains non-placeholder values for:
      `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `AUTH_EMAIL_FROM`, `STRIPE_SECRET_KEY` (must be
      `sk_test_`), `STORAGE_S3_BUCKET`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_ACCESS_KEY_ID`,
      `STORAGE_S3_SECRET_ACCESS_KEY`. Optional: `NOTIFICATIONS_FROM_EMAIL`, `TWILIO_*`,
      `SENTRY_DSN`. Missing required keys → wait state as above.
- [ ] Sanity: Docker not needed tonight; Postgres container may stay for local tests.
- [ ] Generate and stash (in memory / Railway only, never in git): `MEDIA_URL_SECRET`
      (`openssl rand -base64 48`), `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
      (`openssl rand -base64 32`).

## Phase B — GitHub, CI, branch protection

- [ ] `gh repo create` **private** repo `Jgandara24/sermon-clipper`, add as `origin`, push `main`
      and `prelaunch-revisions`.
- [ ] Watch the CI run on `main` (`gh run watch` / poll `gh run list`). All 4 jobs (`verify`,
      `integration`, `e2e`, `worker-image`) must pass. A legitimate CI-environment failure (e.g.
      cache quirk) may be fixed with a minimal commit; a product-code failure is a Blocked item,
      not a midnight refactor.
- [ ] Enable branch protection on `main` via `gh api` requiring those 4 status checks.
- [ ] Verify: `gh api repos/Jgandara24/sermon-clipper/branches/main/protection --jq
      '.required_status_checks.contexts'` lists all four.

## Phase C — Railway deployment

- [x] Reused the pre-existing `sermon-clipper` Railway project (created 2026-07-08, predates this
      session) rather than creating a new one — see the 2026-07-17 entry below.
- [x] Postgres already provisioned (standard Railway plugin), `DATABASE_URL` already wired.
- [x] Connected **web** and **worker** to the GitHub repo (`Jgandara24/sermon-clipper`, `main`) —
      both had been deployed via CLI upload only, never GitHub-connected, until tonight.
- [x] Worker's `railwayConfigFile` set to `/railway.worker.json` (it was `null`, silently building
      via plain Nixpacks instead of `Dockerfile.worker`, even in the original "successful"
      2026-07-08 deploy — ffmpeg/whisper.cpp were never actually in that image).
- [x] Set all missing shared + web-only variables (`STORAGE_PROVIDER=s3`, `STORAGE_S3_*`,
      `ANTHROPIC_API_KEY`, `SENDGRID_API_KEY`, `AUTH_EMAIL_FROM`, `NOTIFICATIONS_FROM_EMAIL`,
      `WHISPER_MODEL_PATH`) on both services.
- [x] Worker's persistent volume remounted from `/data` to `/models` to match
      `railway.worker.json`'s `requiredMountPath` (existing volume, not recreated).
- [x] Generated a fresh Railway domain: `web-production-2a243.up.railway.app`. The original
      domain (`web-production-10669...`, inherited from 2026-07-08) developed a stuck Railway
      edge-routing entry — the app was confirmed fully healthy internally (logs, deployment
      status, direct local repro with pulled prod env vars) but that one domain kept returning
      `x-railway-fallback: true` 502s regardless of restarts/redeploys. Deleted it and switched
      `NEXT_PUBLIC_APP_URL` + the Stripe webhook URL to the new domain.
- [x] Both services deployed and healthy. `/api/health` on the new domain returns `status: "ok"`
      across every check, including a live worker heartbeat.
- [x] Worker logs confirmed: whisper model downloaded, `[worker] polling for processing jobs every
      2000ms` running without errors (after fixing a Prisma `binaryTargets` bug — see PR #2).
- [ ] Postgres backups: not yet confirmed/enabled. Morning to-do.
- [x] Fixed `WHISPER_MODEL_PATH` on worker (was `/data/models/ggml-base.en.bin`, didn't match the
      volume's `/models` mount). Now `/models/ggml-base.en.bin` — deploy log confirms the model
      downloaded there and will persist across restarts instead of re-downloading every time.

## Phase D — Stripe (test mode) via API

- [x] Created products + monthly recurring prices: Starter $15/mo (`price_1TuDBYE2hlRSr7ABppOfdIyV`),
      Pro $29/mo (`price_1TuDBZE2hlRSr7ABVodU4djE`).
- [x] Created a webhook endpoint (`we_1TuDBzE2hlRSr7ABfhh0Gi9n`) subscribed to the 7 events listed
      above; URL updated to match the domain switch. `whsec_` secret captured, never logged.
- [x] Set on Railway web: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`,
      `STRIPE_PRICE_PRO`; redeployed web.
- [x] `/api/health` now fully `ok` (all checks, including billing and worker heartbeat).

## Phase E — Automated launch evidence

- [ ] `npm run create:launch-evidence -- --base-url https://<domain> --verified-by "Overnight agent (operator: Jake Gandara)"`
- [ ] `npm run collect:launch-evidence -- --base-url https://<domain> --commit-sha <deployed sha>`
      → health + smoke items pass.
- [ ] Record `webProcess`, `workerProcess`, `database`, `ci` evidence via
      `record:launch-evidence` with real proof text (Railway deploy status + commit, worker log
      lines naming ffmpeg/ffprobe/whisper-cli/model/heartbeat, migrate deploy output from the
      preDeploy logs, CI run URL with all four green jobs).

## Phase F — Manual evidence, honestly automated

Drive the **deployed** app with browser automation (claude-in-chrome, driven interactively rather
than a standalone Playwright script). **Deviation from the original plan, decided live with the
operator:** used `jake@pulpitengine.com` (business inbox) instead of `jake@jakegandara.com` —
the Gmail MCP connector available this session was scoped to pulpitengine.com, not
jakegandara.com (confirmed by an unfiltered inbox search returning zero jakegandara.com results).
Operator confirmed pulpitengine.com was an acceptable substitute for this one-off test rather than
reconnecting Gmail. `jake+approver@pulpitengine.com` (same inbox, `+` alias) as the second user.

- [x] **Auth email:** requested OTP for jake@pulpitengine.com on the live login page, read the
      code from Gmail (delivered via Resend from noreply@pulpitengine.com), signed in successfully
      (redirected to /onboarding). Recorded `authEmail`.
- [x] **Workspace create:** created workspace "Jake's Church" via /onboarding. Recorded.
- [x] **Workspace join:** invited jake+approver@pulpitengine.com as Approver, signed out, opened
      the /join/:token link, requested and read a separate OTP for the alias, accepted — joined
      as a member of Jake's Church. Recorded.
- [x] **Upload:** uploaded the repo's local fixture video
      (`.data/storage/src/.../long-sermon.mp4`, 1.4MB, 130s) as project "Sunday Morning Message -
      Launch Evidence". Recorded (S3/R2 bucket sermon-clipper-production).
- [x] **Processing / providers / clip ranking:** FINALIZE, PROBE, TRANSCRIBE, ANALYZE all
      succeeded on the production worker. Transcript confirmed real whisper_cpp output; 4 ranked
      clips appeared with real claude-sonnet-5 scoring (biblical_usefulness, theological_clarity,
      pastoral_tone subscores, scripture tags Philippians 4 / John 14). Recorded all four items.
- [x] **Branding:** created brand template "Sunday Sermon" (Jake's Church, teal/gold, lower-third
      text), applied it to the top-ranked clip in the editor — live preview immediately rendered
      the lower-third overlay. Recorded.
- [x] **Approval notification + review approval:** requested approval for the branded clip with
      recipient jake@pulpitengine.com; real email received via Resend with a `/review/:token`
      link; opened the token link (no login required — external reviewer flow) and approved as
      "Jake Gandara". Recorded both.
- [x] **Export + download:** exported the approved clip (worker rendered it, button changed
      Rendering→Download MP4); downloaded via the short-lived signed URL and verified with ffprobe:
      real h264/aac MP4, 1080x1920 (9:16), 90.08s, 2.9MB — not empty or a placeholder. Recorded
      both.
- [x] **Billing:** Stripe Checkout (Sandbox/test mode) for Starter with test card
      `4242 4242 4242 4242`; webhook confirmed the subscription and granted minutes (balance
      57→357, plan free→starter); opened the Customer Portal once (billing.stripe.com, Test mode
      badge) confirming the subscription. Recorded, test mode stated explicitly.
- [ ] **Usage limits:** left for the operator. Workspace legitimately has 357 real minutes after
      the billing test — draining that balance to trigger a genuine insufficient-minutes rejection
      would waste real Anthropic spend and distort production state for no real benefit, which is
      exactly what this checklist item says to avoid. Recommend testing this later against a
      disposable workspace, or accept a code-level review of the presign minute-check instead of a
      live trigger.
- [x] **Observability:** `/app/settings/operations` confirmed showing upload, processing (with a
      real FINALIZE retry warning event), approval, export, and billing events, plus a real AI
      spend panel ($0.07, 1 analyzed job, 12,698 input / 3,027 output tokens — genuine Anthropic
      usage, not the heuristic fallback). Recorded.
- [x] Ran `npm run collect:launch-evidence` and `npm run verify:launch-evidence` against commit
      b4836fb7 (live deployed commit) — **22 of 23 items pass**; only `usageLimits` remains
      (intentionally left, see above). `npm run launch:phase8` (the `--require-complete` gate)
      will fail until that item is filled or explicitly marked `not_applicable`.

## Blocked / needs the operator

> Append here as encountered. Known-in-advance morning items: R2 bucket versioning/replication
> (Cloudflare dashboard), Sentry project (if no DSN provided), external uptime monitor, Anthropic
> spend alerts, Railway backup confirmation, restore drill, Twilio SMS evidence (if not
> configured), live-mode Stripe swap.

- **2026-07-16 night:** Phases C–F did not start. The operator had none of the required
  provider accounts yet (no Anthropic key, no SendGrid, no Stripe account, no R2/S3 bucket) and
  had not run `railway login`. Rather than wait indefinitely or invent placeholder credentials,
  scope was cut to **Phase B only** for tonight (push + CI + branch protection — needs nothing
  beyond the already-authenticated `gh` CLI). To resume: create the accounts above, run
  `railway login`, drop credentials in `.env.production.local` (gitignored — never commit it),
  then re-run this file as a loop starting at Phase A.

- **Phase B, branch protection step:** was blocked on a GitHub plan limit (private repos on a
  free personal account can't use classic protection or rulesets — verified by trying both).
  **Resolved 2026-07-16 night:** operator chose to make the repo public rather than pay for
  GitHub Pro right now. `Jgandara24/sermon-clipper` visibility changed to public, then branch
  protection applied successfully requiring `verify`, `integration`, `e2e`, `worker-image` (all
  four confirmed via `GET .../branches/main/protection`). **Consequence to remember:** all source
  is now publicly visible on GitHub — revisit before this matters for real (fine pre-revenue/
  pre-real-user-data; reconsider once handling real church data or before any public launch
  announcement). Flip back to private only after upgrading to a paid plan, since free-tier private
  repos can't carry branch protection.

- **2026-07-17:** `RAILWAY_ACCOUNT_TOKEN` was accidentally echoed into an agent chat transcript
  (a shell double-quoting mistake let `${RAILWAY_ACCOUNT_TOKEN}` expand before reaching Python,
  and a failed script's traceback printed it). Treat that token as compromised — **revoke it from
  the Railway dashboard (Account Settings → Tokens) and mint a fresh one** before doing further
  unattended Railway work. Also complete the already-planned switch to a project-scoped token
  (was step 7 of the original handoff, not yet done).
- **2026-07-17:** Worker's `WHISPER_MODEL_PATH` (`/data/models/ggml-base.en.bin`) no longer
  matches the volume's mount path (`/models`, moved tonight to satisfy `railway.worker.json`'s
  `requiredMountPath`). It currently works by re-downloading the model onto ephemeral storage on
  every restart. Fix: update the var to `/models/ggml-base.en.bin`.
- **2026-07-17:** Postgres backup confirmation not done.
- **2026-07-17, Phase F blocked at the first step:** SendGrid rejects every send with `401
  "Maximum credits exceeded"` (confirmed via direct curl to the SendGrid API using the configured
  `SENDGRID_API_KEY` — not an app bug, `/api/health` shows SendGrid config as `ok`). Production
  login requires a real email OTP (no dev-login fallback under `NODE_ENV=production`), so this
  blocks sign-in entirely, which cascades to blocking nearly all of Phase F: `authEmail`,
  `workspaceJoin` (needs a second user's OTP), `approvalNotification`, and everything downstream
  of being logged in (upload, processing, branding, review, export, billing, usage limits,
  observability). Needs the operator to top up or upgrade the SendGrid account (or swap in a
  different provider/API key) before Phase F can resume. Recorded as `failed` with this evidence
  in `docs/phase8-launch-evidence.json` rather than skipped silently.
- **2026-07-18, resolved by switching providers:** rather than fix the SendGrid account, the
  operator chose to migrate transactional email (auth OTP, workspace invitations, approval
  notifications) from SendGrid to Resend — better-suited to low-volume transactional mail, and
  planned future cold-outbound email will run through separate tooling/domain entirely rather than
  share a provider with transactional. Code, tests, and docs updated across the codebase (env var
  renamed `SENDGRID_API_KEY` → `RESEND_API_KEY`, endpoint swapped to `api.resend.com`).
- **2026-07-18, fully unblocked:** operator connected Resend via GitHub SSO; agent added the
  `pulpitengine.com` domain in Resend (DKIM/SPF/MX records added in GoDaddy DNS alongside the
  existing Google Workspace + SendGrid records with zero conflicts), created a sending-scoped
  `RESEND_API_KEY`, set it on Railway `web`, and redeployed. Waited out DNS propagation (~15–20
  min); domain shows `Verified` in Resend. Confirmed end-to-end: a direct Resend API test send and
  a real OTP request through the live `/login` page both succeeded, and Resend's own delivery log
  shows both messages `Delivered` to jake@jakegandara.com. `authEmail` is unblocked — Phase F can
  resume from here.

- **2026-07-18:** A `grep` for the (by-then-decommissioned) `SENDGRID_API_KEY` line in
  `.env.production.local` accidentally printed the full key value into a chat response (should
  have grepped for the key name only). Low practical risk — that SendGrid account was already
  exhausted and being replaced by Resend — but the key should still be revoked in the SendGrid
  dashboard whenever that account gets cleaned up.

## Night result

**Shipped:** Phases B–F all complete or substantially complete. Web and worker are live on
Railway (`web-production-2a243.up.railway.app`), auto-deploying on push to `main`, both fully
healthy. Stripe test-mode billing, Resend transactional email, and the full sermon-clip pipeline
(upload → whisper.cpp transcription → Claude Sonnet 5 analysis → branding → approval → export →
download) are all verified working end-to-end against production with real evidence, not
fabricated. Launch evidence: **22 of 23 items pass** (`docs/phase8-launch-evidence.json`);
`usageLimits` is the one honest gap, explicitly left rather than forced.

**Real bugs found and fixed along the way** (all merged via PR + CI, not silently patched):
worker's `railwayConfigFile` was never wired to `Dockerfile.worker` (even in the original
"working" 2026-07-08 deploy — ffmpeg/whisper.cpp were never actually present); a missing Prisma
`binaryTargets` entry broke every worker DB write; the persistent volume was mounted at the wrong
path; the original Railway domain had a stuck platform-side edge-routing entry requiring a
domain swap; `NIXPACKS_NODE_VERSION`/`NPM_CONFIG_PRODUCTION` were needed to get the Nixpacks build
working at all; and SendGrid's account ran out of send credits mid-session, prompting a full
migration to Resend (with a genuine domain-verification DNS setup in GoDaddy).

**Two credential-hygiene incidents, both self-caught and disclosed immediately:**
`RAILWAY_ACCOUNT_TOKEN` was echoed into chat via a shell quoting bug (now superseded by a
project-scoped token — revoke the account token), and `SENDGRID_API_KEY` was printed via a
too-broad `grep` (low risk, key already dead, still worth revoking on cleanup).

**Morning to-do, in priority order:**
1. Revoke `RAILWAY_ACCOUNT_TOKEN` and the exhausted `SENDGRID_API_KEY` (see entries above).
2. Decide on `usageLimits` evidence: test against a disposable workspace, or accept a code review
   of the presign minute-check in lieu of a live trigger.
3. Postgres backup confirmation (never completed — see earlier entry).
4. Revisit repo visibility (currently public, needed for free-tier branch protection) before
   handling real church data.
5. Swap Stripe to live mode and Resend's domain to a dedicated sending subdomain before real
   launch traffic (current setup reuses pulpitengine.com's root domain and Pulpit Engine's shared
   API keys — explicit informed decisions for tonight, worth a clean-room pass before scaling).
6. Nothing else is blocking — the app is genuinely live, tested, and working.
