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

- [ ] Import a short test video (any short clip — doesn't need to be a real sermon)
- [ ] Wait for the project to reach READY (transcribed, analyzed, clips generated)
- [ ] Open the project, pick one clip, and manually export it through the normal editor/export flow until the export job SUCCEEDS
  Notes: (required because Tier 3 never auto-triggers an export — only already-exported clips are eligible to publish)

---

## 4. Force that clip's scheduled post to be "due" today

- [ ] Clips are normally scheduled for future days (rank 1 = the day after the sermon, etc.) — backdate that clip's scheduled date to today so the test doesn't require waiting days
  Notes: (ask me to do this via a direct database update when we're in session — I'll need the clip/project name to find the right row)

---

## 5. Flip the go-live flag

- [ ] Settings → Facebook auto-posting → check "Enable automatic posting" → save
  Notes: (this is the actual go-live moment — from here the worker will attempt a real Graph API call on its next poll)

---

## 6. Trigger or wait for the worker's poll

- [ ] Worker checks for due posts every `FACEBOOK_PUBLISH_POLL_INTERVAL_MS` (default 15 min)
- [ ] A fresh worker restart/redeploy resets its internal timer, so the very first loop iteration checks immediately — ask me to trigger a restart if you don't want to wait
  Notes:

---

## 7. Verify success

- [ ] Calendar page for that workspace shows a "Posted" badge on the clip's slot
- [ ] `/app/settings/operations` shows a `facebook_publish_poll_ran` event, no `facebook_publish_failed` for this post
- [ ] Meta Business Suite → First Baptist Sandbox Page → scheduled content shows a new unpublished scheduled video post
  Notes:

---

## 8. If something fails

- [ ] Check the scheduled post's status/error message (ask me to query it)
- [ ] Common causes: token missing a required permission, wrong Page ID, or the signed media URL expired before Facebook fetched it (30 min TTL from `MEDIA_URL_TTL_SECONDS`)
  Notes:

---

## 9. Clean up afterward

- [ ] Cancel/delete the real scheduled post on the sandbox Page (Meta Business Suite, or ask me to do it via the Graph API)
- [ ] Turn "Enable automatic posting" back off for the test workspace
- [ ] Decide whether to keep or delete the test workspace
  Notes:
