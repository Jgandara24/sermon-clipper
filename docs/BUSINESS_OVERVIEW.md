# Business Overview: Pulpit Engine

> **Status (updated 2026-07-19):** Tiers 1, 2, and 3 are all built and merged. Tier 3 (real Facebook posting) is gated behind a per-workspace `facebookAutoPostEnabled` flag (default off, OWNER-only) — the mechanism exists and can post for real, but a given church's Page only actually goes live once an owner explicitly flips that flag. See DECISIONS.md, "Tier 3 Freeze Lifted", for why the original ≥3-churches freeze no longer applies and what replaced it.

## What This Business Does (A to Z)

Churches record sermons every week, but most of that content just sits there. Almost none of it gets turned into short videos that grow the church's social media presence, because pastors and staff don't have time to watch a 40-minute sermon, find the good parts, cut clips, and post them every day.

Pulpit Engine does that job for the church, automatically.

The church keeps doing exactly what it already does: preach and record. From there, Pulpit Engine takes over:

1. It pulls in the sermon as soon as it's available.
2. It watches the sermon and finds the best, most shareable short moments.
3. It cuts those moments into short video clips.
4. It picks the strongest clips and puts them in order.
5. It posts one clip per day to the church's Facebook page, based on how often they stream.

The result: the church's Facebook page stays active every single day with good content, without anyone on staff lifting a finger after the initial setup.

## Scheduling Rules (How Many Clips We Need)

During onboarding, the church tells us whether they stream:

- **One service per week** (for example, Sunday morning only), or
- **Two services per week** (for example, Sunday morning and Wednesday night).

Based on that, Pulpit Engine handles clips like this:

- **If they stream once a week (Sunday only):**
  - Pulpit Engine creates **6 clips** from the Sunday sermon.
  - It posts **1 clip per day, Monday through Saturday.**
  - **No clips are posted on Sunday.**

- **If they stream twice a week (Sunday & Wednesday):**
  - Pulpit Engine creates **3 clips from the Sunday sermon** and **3 clips from the Wednesday sermon.**
  - Clips from **Sunday** are posted **Monday, Tuesday, and Wednesday.**
  - Clips from **Wednesday** are posted **Thursday, Friday, and Saturday.**
  - **No clips are posted on Sunday.**

## Step-by-Step Workflow

1. Church signs up for Pulpit Engine.
2. Church tells us if they stream **1 or 2 services per week** (Sunday only, or Sunday & Wednesday).
3. Church connects their existing sermon source (wherever they already stream or upload).
4. Church preaches and records like normal.
5. Pulpit Engine detects each new sermon automatically once it's posted.
6. Pulpit Engine finds and cuts multiple short clips from that sermon.
7. Pulpit Engine scores and ranks the clips to identify the strongest ones.
8. Based on the church's weekly service pattern, Pulpit Engine schedules clips so that **one clip goes out per day, Monday through Saturday, and never on Sunday.**
9. Pulpit Engine posts the clips to the church's Facebook page automatically.
10. The cycle repeats with every new sermon, without the pastor or staff needing to download, cut, choose, or upload anything.

## What Building This Requires (when unfrozen)

- A `servicesPerWeek` (or equivalent) field on the church/workspace record, set at onboarding.
- Frequency-aware clip-count logic replacing the flat `TARGET_CLIP_COUNT = 8` in `analyze.ts`.
- A Facebook scheduling/posting subsystem: `ScheduledPost`-style model, day-of-week assignment logic (Mon-Sat, skip Sunday), and actual Facebook Page publishing integration — none of which exist in the codebase today.

## Product Phases

### Phase 1 (MVP): Video Reels Only

Goal: one highlight reel per day, with simple but future-proof settings.

**Onboarding**
- Ask: "How many sermons do you typically stream or upload each week? (1 or 2)"
- If 2: assume Sunday & Wednesday for now.

**Default posting rule**
- `Total posts per day` (integer, default = 1).
- Content types available in Phase 1: video reels only.
- Post schedule:
  - 1 sermon/week: generate at least 6 highlight clips from the Sunday sermon; auto-schedule 1 clip per day, Mon-Sat.
  - 2 sermons/week: generate at least 3 clips from the Sunday sermon and 3 from the Wednesday sermon; auto-schedule Sunday's clips to Mon/Tue/Wed and Wednesday's clips to Thu/Fri/Sat.
- No posts on Sunday in Phase 1.

**UI expectation (Phase 1)**
- Simple control, per account:
  - `Total posts per day: [integer stepper]` (default 1)
  - `Video reels per day: [integer stepper]` — must equal total posts per day in Phase 1.

### Future Phase: Multiple Content Types

Adds generated text posts and infographic/image posts alongside video reels.

**Desired behavior**
- User sets `Total posts per day: [integer stepper]` (e.g., 3), then a breakdown by type:
  - `Video reels per day: [int]`
  - `Text posts per day: [int]`
  - `Infographic/image posts per day: [int]`
  - Rule: sum of all content-type counts must equal total posts per day.
- Sermon-based logic stays the same: 1 sermon/week spreads content Mon-Sat from that sermon; 2 sermons/week has the Sunday sermon power Mon-Wed and the Wednesday sermon power Thu-Sat.
- The scheduling engine should always back into: how many posts of each type are needed per day, and how many sermon "days" each upload must cover, based on whether the church has 1 or 2 weekly sermons.

## Roadmap Tiers (Build Sequencing)

### Tier 1 — Onboarding & Clip Sizing (done)

Churches say how many sermons per week they have, and the number of clips generated per sermon (6 or 3+3) matches that automatically. No posting or scheduling yet — this only affects how many clips get made.

### Tier 2 — Weekly Posting Calendar (next up, no auto-posting yet)

Two pieces:

1. **Knowing which sermon is which.** The system figures out whether an uploaded sermon was the Sunday one or the Wednesday one, so it can apply the right posting days to its clips.
2. **A visual weekly calendar of clips, with a platform picker per clip.** Each scheduled slot (e.g., "Monday, Clip 1") is clickable, and clicking it lets you choose which social platform that clip is destined for — Facebook, Instagram, TikTok, or YouTube. **Facebook is the only one that's actually live right now** — Instagram, TikTok, and YouTube show up as selectable options in the calendar so the design is ready for them, but posting to those platforms isn't built yet and won't do anything if picked. This calendar does not post anything by itself — it's a plan, not an action. Someone still has to publish each clip by hand until Tier 3 exists.

### Tier 3 — Automatic Posting (built, gated behind a manual go-live flag)

The calendar from Tier 2 posts itself — no manual publishing step, for a church that has explicitly gone live. Reuses Pulpit Engine's existing Meta App/Business Manager (DECISIONS.md, "Sermon Clipper's Tier 3 Facebook Auto-Posting Will Reuse Pulpit Engine's Meta App/Business Manager") rather than a new app review.

How it works:

1. **Connect**: an owner sets the church's Facebook Page ID in Settings, once that Page has been granted to the Business Manager's System User (a manual, one-time step outside this app, mirroring how Pulpit Engine onboards a church's page today).
2. **Go live**: the owner flips "Enable automatic posting" — off by default, OWNER-only permission (`MANAGE_FACEBOOK_CONNECTION`), deliberately a bigger speed bump than any other setting in the product.
3. **Publish**: a worker loop (`src/lib/integrations/facebook-publisher.ts`) scans for due, unposted calendar slots every `FACEBOOK_PUBLISH_POLL_INTERVAL_MS` (default 15 min) and, only for a workspace that is both connected and live, schedules an unpublished Facebook video post via the Meta Graph API — but only once a human has actually exported that clip through the normal review flow; this tier never triggers an export by itself.

Fails closed at three independent layers: no `META_SYSTEM_USER_TOKEN` in the environment means the whole worker is a no-op regardless of any workspace's settings; no Page ID or the flag off means that workspace is skipped; an unexported clip is skipped until it's exported. Idempotent — a scheduled post is never published twice, mirroring the exact state-machine discipline Pulpit Engine already proved in production once.
