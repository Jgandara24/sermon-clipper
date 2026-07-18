# Business Overview: Pulpit Engine

> **Status:** This document describes the target product experience and scheduling design, written 2026-07-18. **It is not yet implemented.** As of this date, the codebase has no Facebook posting/scheduling subsystem, no per-church service-frequency setting, and clip generation is a flat `TARGET_CLIP_COUNT = 8` per sermon regardless of church (`src/lib/jobs/handlers/analyze.ts`). Per the approved CTO consultation, publishing/scheduling is one of the features intentionally frozen until at least 3 churches ask for it — see CTO.md and project memory. Treat this as the spec to build against when that freeze lifts, not a description of current behavior.

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
