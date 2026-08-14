# Tier 3 Facebook Auto-Posting — Sandbox End-to-End Test Checklist

**Purpose:** prove the whole Tier 3 pipeline (connect → export → schedule → publish) actually
works against a real Facebook Page, before offering it to a real church. Uses the "First Baptist
Sandbox" Page (`1128280933691493`) already assigned to Pulpit Engine's Meta Business Manager
System User — not a real church's Page, so a real scheduled post landing there is expected and
low-risk.

**Status as of 2026-07-19:** `META_SYSTEM_USER_TOKEN` and `META_GRAPH_API_VERSION=v25.0` are set
on the `worker` Railway service and deployed. No workspace has `autoPostEnabled=true` yet — this
checklist is what turns that on, for the sandbox only.

Add your own notes under each `Notes:` line as you go — revisions, things to change, questions.

---

## 0. Pre-flight

- [ ] Confirm `worker` service is Online (`railway status`)
  Notes:

- [ ] Confirm `META_SYSTEM_USER_TOKEN` / `META_GRAPH_API_VERSION` are still set on `worker`
  Notes:

- [ ] Confirm the sandbox Page ID is still `1128280933691493` (Business Manager → System Users → PEPA → Assigned assets)
  Notes:

---

## 1. Set up a dedicated test workspace

- [ ] Sign up / log into production (https://app.pulpitengine.com) with a clearly-named test account
  Notes:

- [ ] Complete onboarding: name the workspace something obvious like "Tier 3 Sandbox Test", set sermons/week, service day, timezone
  Notes:

---

## 2. Connect Facebook (don't go live yet)

- [ ] Settings → Facebook auto-posting → enter Page ID `1128280933691493`
- [ ] Leave "Enable automatic posting" **off** for now — save and confirm the connection persists
  Notes:

---

## 3. Get one real exported clip into the pipeline

- [x] Import a short test video (any short clip — doesn't need to be a real sermon)
- [x] Wait for the project to reach READY (transcribed, analyzed, clips generated)
- [x] Open the project, pick one clip, and manually export it through the normal editor/export flow until the export job SUCCEEDS
  Notes: (required because Tier 3 never auto-triggers an export — only already-exported clips are eligible to publish)
  2026-07-24: Done with project "Stage A Fix Verify 7-24" (the real 50-min sermon, YouTube import
  via residential proxy). Required PR #23 first — ANALYZE Stage A had the same token-cap
  truncation bug PR #22 fixed for Stage B. Pipeline then completed end-to-end: 2 clips generated
  ($0.19 AI spend, 112K in / 7.3K out tokens). Rank-1 clip "Series Revealed: 'Upside Down'"
  (e6a02141-4a93-4a97-ba62-ce0f1d6bedca) approved via review link (no reviewer email/SMS sent)
  and exported successfully (Download MP4 available).

---

## 4. Force that clip's scheduled post to be "due" today

- [x] Clips are normally scheduled for future days (rank 1 = the day after the sermon, etc.) — backdate that clip's scheduled date to today so the test doesn't require waiting days
  Notes: (ask me to do this via a direct database update when we're in session — I'll need the clip/project name to find the right row)
  2026-07-24: Done. scheduled_posts row 4f5c9c02-2cfe-4cf2-84a4-ba5c9307150d ("Series Revealed:
  'Upside Down'") backdated 2026-07-25 → 2026-07-24, publish_status still not_started. Next step
  is section 5 (flip autoPostEnabled) — awaiting explicit go-ahead.

---

## 5. Flip the go-live flag

- [x] Settings → Facebook auto-posting → check "Enable automatic posting" → save
  Notes: (this is the actual go-live moment — from here the worker will attempt a real Graph API call on its next poll)
  2026-07-24: Flipped on with Jake's explicit go-ahead. Settings badge switched to "LIVE — posting
  automatically". (The "Meta credentials: not configured" badge on the web app is cosmetic — the
  token lives on the worker service, verified present.)

---

## 6. Trigger or wait for the worker's poll

- [x] Worker checks for due posts every `FACEBOOK_PUBLISH_POLL_INTERVAL_MS` (default 15 min)
- [x] A fresh worker restart/redeploy resets its internal timer, so the very first loop iteration checks immediately — ask me to trigger a restart if you don't want to wait
  Notes: 2026-07-24: no restart needed — the natural poll fired at 06:15 UTC, ~4 min after go-live.

---

## 7. Verify success

- [x] Calendar page for that workspace shows a "Posted" badge on the clip's slot
- [x] `/app/settings/operations` shows a `facebook_publish_poll_ran` event, no `facebook_publish_failed` for this post
- [ ] Meta Business Suite → First Baptist Sandbox Page → scheduled content shows a new unpublished scheduled video post
  Notes: 2026-07-24: scheduled_posts row shows publish_status=succeeded,
  facebook_post_id=999309073105794, attempt_count=0, no error. Calendar shows "Posted" on the
  Fri Jul 24 slot. Meta Business Suite check is Jake's — needs his Facebook login.

---

## 8. If something fails

- [ ] Check the scheduled post's status/error message (ask me to query it)
- [ ] Common causes: token missing a required permission, wrong Page ID, or the signed media URL expired before Facebook fetched it (30 min TTL from `MEDIA_URL_TTL_SECONDS`)
  Notes:

---

## 9. Clean up afterward

- [x] ~~Cancel/delete the real scheduled post on the sandbox Page~~ — **not required, by design**
- [x] Turn "Enable automatic posting" back off for the test workspace
- [x] Decide whether to keep or delete the test workspace — **keep**
  Notes: 2026-08-11: verified directly against the production database (read-only audit).

  **Auto-posting is off in every workspace.** Two workspaces exist:
  - `Jake's Church` (126383aa-326e-4971-8ac7-de70be58a730, created 07-18) — autoPostEnabled false, no Page ID.
  - `Tier 3 Sandbox Test` (7e56d1fd-6ab6-4fb3-8810-17dec32b4f25, created 07-23) — autoPostEnabled false,
    Page ID still `1128280933691493`. Page ID retained deliberately so the workspace stays ready for the
    P2 delivery-gate proof; it is inert while autoPostEnabled is false, and `isEligibleForAutoPost()`
    requires both.

  **The sandbox Page is a permanent, disposable test asset.** First Baptist Sandbox
  (`1128280933691493`) is Jake's own page, maintained for exactly this purpose. Test posts are not
  cleaned up and do not need to be. Post `999309073105794` from 07-24 stays as evidence. This makes
  the page a reusable target for the P1.12 publish-intent work and the P2 sandbox go-live proof —
  real Graph API behavior can be exercised without a customer page.

  **Scheduled-post state (whole database, 2026-08-11):** exactly two rows.
  - SUCCEEDED — 07-24, post `999309073105794`, clip "Series Revealed: 'Upside Down'".
  - NOT_STARTED — 07-26, clip "Young Preachers Announced for New Series", **no successful export**.
    Its date has passed and it never published. Two independent gates stopped it: auto-posting is off,
    and `publishDueScheduledPosts` skips any clip with no SUCCEEDED export
    (`postsSkippedNotExported`). Tier 3 never triggers an export on its own, and only rank 1 was
    exported by hand. This row is the live proof that manual export is currently the binding safety
    constraint — the constraint that P2.4's render coordinator removes, which is why the publish kill
    switch (P0.16) and the Delivery Eligibility Module (P1.11) must both ship before it.

  Sections 1 and 2 were completed on 07-23 but left unticked; the workspace name above confirms it.
