# P3 Exit — Manual Test Script

**Purpose:** verify operator access in production and check the pool and preview against real
data. The review (`AGENTIC_EDITOR_PROGRESS.md`, "P3 exit review, 2026-09-06") proved eleven of
twelve exit criteria from code and tests. Criterion 2 also needs production evidence because
`isPlatformOperator` is stored on the production `User` row. Criteria 1 and 6 need a browser check.

**Who ran this:** Jake and Codex in Chrome. Jake completed sign-in, approved the operator grant,
selected the demo recording, and confirmed audio. Codex operated the browser and ran the terminal checks.

**Status as of 2026-09-08 (America/Chicago):** all three browser criteria passed after the operator grant and the First Baptist Demo retest. Jake confirmed audio. Results are recorded for review.

**Deployment at the time of the test.** Verified 2026-09-08 against `/api/health`:

```
"commitSha": "b510960f093462d2ebc5282d2431a36796f57ef4"
"migrations": "No incomplete Prisma migrations found."
"worker_heartbeat": "Worker worker-1 heartbeat is recent (16s old)."
```

`b510960` was the `main` head at the time of the test and included the P2 and P3 changes.
`AGENTIC_EDITOR_PROGRESS.md` records this deployment and the browser results.

**Base URL:** `https://web-production-2a243.up.railway.app`

This is the Railway deployment of this repository. It is not `app.pulpitengine.com`, which belongs
to the old Pulpit Engine build in a separate Google Cloud project. The health check above is the
proof: it reports this repository's commit.

Add your own notes under each `Notes:` line as you go.

---

## 0. Sign in

- [x] Open `https://web-production-2a243.up.railway.app/login`
  Notes: The production login page opened in Chrome.

- [x] Enter `jake@jakegandara.com`. Request a code. Enter the six-digit code from your email
  Notes: The site reported that it sent the code. Jake completed sign-in. The browser opened `/app` and showed his email and the First Baptist Demo workspace.

**Expected:** the browser goes to `/app` and shows the dashboard.

**Failure sign:** "We could not send that sign-in code." Resend is then the problem, not this
test. Stop.

---

## 1. Criterion 2 — the operator marker

The gate is `requirePlatformOperator()` in `src/lib/auth.ts:107`. It reads `isPlatformOperator` on
your `User` row. Repository tests do not establish its production value. This browser check
confirms access; the optional terminal check reads the production marker directly.

- [x] Open `https://web-production-2a243.up.railway.app/app/operator/review`. Watch the address bar
  Notes: Initial FAIL; retest PASS. The browser redirected to `/app?error=permission-denied`. No operator page appeared. The production `--list` check returned "No user holds the platform-operator marker." A read-only database query confirmed `isPlatformOperator: false` for Jake. Jake then approved the grant. The documented grant script succeeded. The route opened in the existing session on retest; sign-out and sign-in were not needed for this check.

### Expected result if the column is `true`

- [x] The address bar stays on `/app/operator/review`
  Notes: PASS. The browser stayed on this route after the grant.

- [x] You see the small teal word **Operator**
  Notes: The review queue showed Operator. A screenshot of the operator project page also confirmed the small teal marker.

- [x] You see the heading **Review queue**
  Notes: PASS. The heading appeared.

- [x] You see "Every scheduled slot awaiting a decision, across every church, soonest first."
  Notes: PASS. The text appeared.

- [x] You see one of two boxes: "The 30-day human-only review phase has not started." or
      "Day N of 30 · your decision is the authority"
  Notes: PASS. The page said "The 30-day human-only review phase has not started."

- [x] You see a list of slots, or the text "Nothing is waiting for a decision."
  Notes: PASS. The queue showed slots from Tier 3 Sandbox Test and Jake's Church.

**An empty list is still a pass.** The proof is that the page renders at all.

### Expected result if the column is `false` or `null`

- The address bar changes to `/app?error=permission-denied`.
- You see the dashboard, not the operator page.
- **No message says "you are not an operator".** The gate is silent on purpose. It sends you to
  the same place a permission refusal goes, so the operator surfaces do not announce themselves.

**Failure sign:** the redirect to `/app?error=permission-denied`.

### Optional terminal check

This reads only. It writes nothing.

```bash
npm run set:platform-operator -- --list
```

It prints `jake@jakegandara.com (<uuid>) granted <date>`, or "No user holds the platform-operator
marker."

### If this step fails

Run this at a terminal that holds the production `DATABASE_URL`. `npm run set:platform-operator`
is the only door — there is no route, action, or settings toggle that grants the marker, by
decision (`DECISIONS.md`, "The Operator Marker Is Granted Only At A Shell, And Never
Billing-Gated").

With the Railway CLI:

```bash
railway run npm run set:platform-operator -- --email jake@jakegandara.com --grant
```

Or with the URL supplied directly:

```bash
DATABASE_URL='<production database url>' npm run set:platform-operator -- --email jake@jakegandara.com --grant
```

**Expected output:**

```
Granted platform-operator authority to jake@jakegandara.com (<uuid>).
```

If it prints "already holds the platform-operator marker. Nothing changed.", the column was already
`true`. The redirect had a different cause. Stop and report it.

- [ ] After the grant, sign out, sign in again, and repeat section 1
  Notes: Deviation: the retest used the existing session. The operator route reads the current user marker on each request. A fresh sign-in after the grant was not tested.

---

## 2. Criterion 1 — the complete candidate pool

P3.1 shipped a defect that emptied every church project page, and the unit tests did not catch it.
This step looks for that defect shape on real data.

- [x] Open `https://web-production-2a243.up.railway.app/app`
  Notes: PASS. The dashboard showed the new test service in First Baptist Demo.

- [x] Choose a service you know produced clips. Click its card. The address becomes
      `/app/projects/<projectId>`
  Notes: PASS. Opened P3 Demo Test — Clip Count Retest 8-11 after normal processing succeeded.

- [x] **Copy that `<projectId>`. Section 3 needs it**
  Notes: Project ID: `75108e04-d3cd-49fd-a854-927e6501c04b`.

- [x] Scroll to the section **Clips from this sermon**
  Notes: PASS. The section appeared on the church page.

### Expected result

- [x] One line reads `N ranked clips from this service.`
  Notes: PASS. The line read "6 ranked clips from this service."

- [x] `N` is more than 0
  Notes: PASS. N = 6.

- [x] `N` equals the number of clip cards below the line
  Notes: PASS. The church page had exactly 6 clip cards.

- [x] The line names no ceiling. "12 of 18" and "up to 18" are both forbidden. The configured limit
      is a staff control that a church must not see
  Notes: PASS. No clip ceiling or configured limit appeared in the church pool.

### Failure signs

| What you see | What it means |
|---|---|
| "No clips yet." on a service that you know produced clips | **This is the P3.1 defect shape. Stop and report it.** |
| The count does not equal the number of cards | The pool and the cards disagree. Stop and report it. |
| Any text that shows a limit or a ceiling | A staff control leaked to a church surface. Stop and report it. |

### Cross-check the same service as an operator

This needs section 1 to pass.

- [x] Open `https://web-production-2a243.up.railway.app/app/operator/projects/<projectId>`
  Notes: PASS. Opened the same project on the operator route.

- [x] The same service appears, with the church name at the top
  Notes: PASS. The heading named the demo service and First Baptist Demo.

- [x] The candidate count matches the church page
  Notes: PASS. The operator page showed 6 retained clips and 6 candidate preview controls.

- [x] The operator page also shows slots and limits. The church page shows neither
  Notes: PASS. The operator page showed a ceiling of 18 and a Posting dates section with no dates. Neither appeared in the church pool.

**Failure signs:** a different candidate count on the two pages, a 404, or a crash.

---

## 3. Criterion 6 — on-demand preview against real signed media

The preview must create no `ExportJob`, no MP4, and no derivative. It plays one span of the sermon
recording through byte ranges.

- [x] Open `/app/exports` in a second tab. Write down how many export jobs it lists
  Notes: PASS. The demo export page showed no exports. Baseline = 0.

- [x] Return to `https://web-production-2a243.up.railway.app/app/projects/<projectId>`
  Notes: PASS. Returned to the demo church project page.

**Choose the clip with care.** Do not choose a clip whose summary reads "This date is filled by a
clip from an earlier service." A borrowed clip is cut from a different recording, so its preview is
null by design.

- [x] On a clip card, click **Preview this moment**
  Notes: PASS. Opened rank 1, Consider It Pure Joy... During Suffering? It was not a borrowed clip.

- [x] A video player appears below the button. It is black. It has controls
  Notes: PASS. A black player with controls appeared.

- [x] Press play
  Notes: PASS. Clicked Play. Jake confirmed that the audio plays.

### Expected result

- [x] Nothing plays until you press play. **The sermon must not start talking on its own**
  Notes: PASS. Before Play, currentTime = 0, paused = true, autoplay = false, preload = none.

- [x] Playback starts at the clip start, not at minute 0 of the service
  Notes: PASS. Just after Play, currentTime = 175.57 seconds and paused = false. This matches the selected start.

- [x] Playback stops at the clip end
  Notes: PASS. Playback progressed within the span and stopped automatically. See the sampled positions in section 5.

- [x] The player returns to the clip start. Press play again and it replays the same moment
  Notes: PASS. The player reset to 175.57 seconds. Replay started at 177.159838 seconds on the first sample and continued within the same span.

- [x] Click **Hide this moment**. The player disappears
  Notes: PASS. Hide this moment removed the player while replay was running. The browser then reported 0 video elements.

- [x] Reload the `/app/exports` tab. **The export job count is unchanged**
  Notes: PASS. Reloaded the export page. It still showed no exports. Final count = 0; a read-only database check also found 0.

### Failure signs

| What you see | What it means |
|---|---|
| "The sermon recording for this service has been deleted, so this moment can no longer be played." | The signed URL is null. Either retention purged the media, or you chose a borrowed clip. Choose another clip or another service. |
| The player appears but play fails | Open the browser network tab. Find the request to `/api/media/signed`. Read its status. |
| `/api/media/signed` returns **403** "Invalid media link." | The signature expired. A signed URL lives 15 minutes (`DEFAULT_MEDIA_URL_TTL_SECONDS`). Reload the page and press play within 15 minutes. |
| `/api/media/signed` returns **404** "Storage hiccup" | Storage cannot find the key. Stop and report it. |
| Playback runs past the clip end and keeps playing the sermon | The stop rule failed. Stop and report it. |
| Playback starts at minute 0 | The seek to the clip start failed. Stop and report it. |
| The export job count went up | **Stop immediately.** A preview created a render. This breaks criterion 6. |

---

## 4. Result

The outcomes below are also recorded in `AGENTIC_EDITOR_PROGRESS.md` under the P3 exit review.

| Section | Criterion | Pass or fail | What you saw |
|---|---|---|---|
| 1 | 2 — operator marker | PASS AFTER GRANT | The initial request was denied. Jake approved the grant to `jake@jakegandara.com`. The documented script succeeded, and the operator queue opened in the existing session. |
| 2 | 1 — complete pool | PASS | The demo church page showed 6 ranked clips and 6 cards. The operator page showed the same 6 candidates. Limits and posting dates appeared only on the operator page. |
| 3 | 6 — on-demand preview | PASS | The demo church preview waited for Play, started at the clip start, stopped and reset, replayed, and closed. Jake confirmed audio. The browser export count stayed at 0. |

**Export job count, section 3:** First Baptist Demo: before **0**, after **0**, verified in the browser. A read-only database query also found 0 after the preview. Storage objects were not audited separately.

**Date run:** 2026-09-08 (America/Chicago; 2026-09-09 UTC).

**Initial run notes (before the demo retest):**

- Test project: `2a3e5748-ea43-4d3b-b897-1f4019f8b9fc`, Clip Count Retest 8-11, Jake's Church.
- Operator page: `/app/operator/projects/2a3e5748-ea43-4d3b-b897-1f4019f8b9fc`.
- Church page: `/app/projects/2a3e5748-ea43-4d3b-b897-1f4019f8b9fc`. It showed "This page couldn’t load", "A server error occurred. Reload to try again.", and error `1691764594`. The source checks the project's workspace against the user's primary workspace. The workspace mismatch is a likely cause; server logs were not checked.
- Selected clip: rank 1, Consider It Pure Joy? Christianity's Flip. The card shows 2:55–3:52. The video URL fragment specifies 175.57–232.19 seconds. This was not a borrowed clip.
- Opening the preview showed a black player with controls and a play icon. Playback began only after Play was clicked. The video had `autoplay: false` and `preload="none"`.
- During the first playback, the browser reported 190.127236 and 202.50225 seconds with `paused: false` and no media error. After the span, it reported 175.57 seconds with `paused: true`.
- Replay reported 175.879613 seconds with `paused: false`, then 226.160013 seconds. It again stopped at 175.57 seconds with `paused: true`. This confirms playback within the selected span and reset. The exact stop boundary was not measured frame by frame.
- Hide this moment removed the player. The browser reported 0 remaining preview players.
- These initial preview checks used the operator page. The later demo retest completed the church-page checks and audio confirmation; see section 5.
- Jake has one active workspace membership, as OWNER of First Baptist Demo. Production has 9 projects in total, but none belongs to this workspace. The remaining church tests need an account with the correct primary workspace, or a suitable service in First Baptist Demo.
- The approved operator grant was the only production permission change. No test data was created during the initial run. The later demo setup is recorded below. Results are recorded for review.


## 5. First Baptist Demo retest

Jake selected First Baptist Demo as the test church and authorized reuse of the Clip Count Retest 8-11 recording.

- Test project: `75108e04-d3cd-49fd-a854-927e6501c04b`, P3 Demo Test — Clip Count Retest 8-11.
- Source service date: 2026-08-11. Main weekly service.
- Setup: copied the existing 392,808,104-byte recording to a separate storage object in First Baptist Demo. Created a new source record and called `createProjectFromUploadedSourceVideo`, which enqueued the normal FINALIZE job. No existing clips or transcript were copied. The original project was not changed.
- Automatic publishing and automatic schedule arming were both disabled at setup.
- Finalize, Probe, Transcribe, and Analyze all succeeded. The project is READY with 6 new clips. The transcript loaded in the church page and identified `whisper_cpp` as its provider.
- No commit or push was made during the browser test. The temporary setup helper is under ignored `tmp/p3-demo-test/`.

### Demo browser evidence

- Church route: `/app/projects/75108e04-d3cd-49fd-a854-927e6501c04b`.
- Operator route: `/app/operator/projects/75108e04-d3cd-49fd-a854-927e6501c04b`.
- Church pool: "6 ranked clips from this service." There were 6 article cards, all in reserve. No configured clip ceiling or posting-date section appeared in that pool.
- Operator pool: 6 retained, 6 candidates, ceiling 18. Posting dates: "This service owns no posting dates." Automatic schedule arming was disabled.
- Preview: rank 1, Consider It Pure Joy... During Suffering?, 175.57–232.19 seconds. The player was black with controls before Play; `paused=true`, `currentTime=0`, `autoplay=false`, and `preload=none`.
- First play: `currentTime=175.57`, `paused=false`; later `221.574334`, `paused=false`; after the span `175.57`, `paused=true`. No media error was reported. The exact stop boundary was not measured frame by frame.
- Replay: `currentTime=177.159838`, `paused=false`; later `225.30472`, `paused=false`. Hide this moment then removed the player. The browser reported 0 remaining video elements.
- Jake confirmed: "Yes, the audio plays."
- The export page showed "No exports yet" before and after the preview: 0 → 0. The final database check also returned 0 demo export jobs.
- Additional finding: the operator page displayed an open `TRANSCRIPTION PROVIDER FALLBACK` exception. It says the backup provider was used and captions need review before publication. This did not block the pool or source-preview tests. Caption accuracy was not tested here.
- The source project remains separate and unchanged. No export was requested. No publishing or scheduling setting was changed. No commit or push was made during the browser test.
