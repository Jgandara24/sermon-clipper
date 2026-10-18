# Founder brief

Date: 2026-10-17. Owner: Jake. Written in plain words for a non-technical founder.
This file says what we want at the end, the next goal, and the order of work.
The words in this file follow [CONTEXT.md](../CONTEXT.md).

## 0. The product is Pulpit Engine (agreed 2026-10-17)

The final name is **Pulpit Engine**. "Sermon Clipper" was only the working name of this rebuild.
Jake built a first version of Pulpit Engine, did not like it, and started this code base to replace it.
This code base is the product. See [ADR 0001](adr/0001-the-product-is-named-pulpit-engine.md).

What this means:
- Every place the church sees "Sermon Clipper" changes to "Pulpit Engine": the app title, the sign-in page, the menu, and the emails. About 30 files.
- The first build's useful pieces carry over: the name, pulpitengine.com, the Meta App, the shared Cloudflare account (Stream and PERC), and the church directory as a lead list.
- Internal names change later and carefully: the GitHub repository, the Railway project, the package name, and the production web address.

### What we share with the first build (agreed 2026-10-17)

| Piece | Carry over? | Why |
|---|---|---|
| Name and pulpitengine.com | Yes | It is the brand. |
| Meta App and Business Manager | Yes, already in use | Facebook posting already runs through it. |
| Cloudflare account, PERC | Yes, already shared | One account, one bill. A Sunnylane PERC input already exists. |
| Church directory in Supabase | Yes, as a lead list only | It is a list of churches to sell to. |
| First build's Supabase as the product database | No | One product, one database. See [ADR 0002](adr/0002-one-product-database-on-railway.md). |
| First build's app code and n8n workflows | No | The rebuild replaces them. |
| First build's Railway services | Turn off later | First check what still runs. Then turn off what nothing uses. |

"Combining the two products" means this table. It does not mean merging code or databases. The work in this table waits until Phase 1 ends, except the visible rename, which happens before Priority 2.

## 1. Desired outcome (agreed 2026-10-17)

The system gets the sermon on its own. First by YouTube import. Later by PERC.
The system finds the best moments. It makes short clips with captions.
It plans which day each clip goes out. It posts the clips to the church's social pages.
No person edits a clip. No person has to check a clip.
The clips are so good that both Jake and the church would accept them.
The church pays a small monthly fee. Thousands of churches use it.

### The path to hands-off posting

1. **Proving period.** Jake checks every clip for the first churches. He sees the quality with his own eyes.
2. **Church check.** The church approves its week of clips with one tap. This is the default setting.
3. **Hands-off posting.** The church turns the check off when it trusts the clips. This is the end state.

## 2. Phase 1 goal (agreed 2026-10-17)

One real church gets one full week of clips, every week, for 4 weeks in a row.
The system pulls the sermon from YouTube. It makes the clips and plans the days.
Jake checks the clips. They post to the church's Facebook page.
Jake accepts 6 of every 6 clips. Not 5. Every posted clip must be worthy of the church members and the public.

### How we count (agreed 2026-10-17)

We count the system's first picks, not the posted clips.
Jake may swap a bad clip for a reserve, so the church still gets its 6 clips.
But a week with a swap or a reject does not count.
Phase 1 ends after 4 weeks in a row with no swap and no reject.
If a week fails, the count of 4 starts again.

### The Phase 1 church (agreed 2026-10-17)

The Phase 1 church is **Sunnylane Baptist Church**. Jake's dad is the pastor. Jake is a member.
All test sermons come from Sunnylane: its livestream and its YouTube channel.
Test clips post first to the **sandbox page**, the Facebook page named "First Baptist Sandbox". No church member sees it.
Clips post to the sandbox page until one full week has no swap and no reject. Then they post to Sunnylane's real Facebook page.
Sandbox weeks count toward the 4 clean weeks. The sandbox week is week 1 of 4. The real page gets weeks 2, 3, and 4.
If a week fails after the switch, clips stay on the real page. Jake swaps the bad clip, and the count starts again.

Note: the code already has a 30-day period where only Jake checks clips. That period is a minimum. Time alone never ends it. Jake ends it by hand. So "4 clean weeks in a row" is the proof Jake uses to end it. There is no conflict.

### What "a good clip" means (agreed 2026-10-17)

A clip passes only when all of these are true:

1. **It starts on time and ends on time.** The start and end do not feel odd. It looks like a person reviewed and edited it.
2. **The preacher is preaching.** It is not announcements, baptisms, an altar call, worship, prayer, or similar.
3. **The video shows the preacher the whole time.** If the church's video cuts to a verse slide, song words, or a logo for any part of the clip, the clip fails. Our own captions are fine. The preacher reading a verse out loud is fine.
4. **It is engaging.** It holds attention on social media.

Instagram, TikTok, and YouTube Shorts come after Phase 1.

## 3. Priorities

### Priority 1 — quality first, in the lab (agreed 2026-10-17)

We fix the clip picker with old Sunnylane sermons before anything posts.
Jake judges the clips with his own eyes and ears, against the four quality tests.
Posting to the sandbox page switches on only after the lab clips pass.
The weekly loop (Sunday sermon in, Monday check) starts after that.

**Lab finish line (agreed 2026-10-17):** 3 old Sunnylane sermons, 6 clips each. All 18 clips pass the four tests.
For each clip, Jake gets the clip to watch, the start and end time, and the words.
Jake marks each clip pass or fail, and names the test it failed.
If any clip fails, we fix the picker and run all 3 sermons again.

**The 3 lab sermons (chosen by Jake, 2026-10-17).** All three come in through the real YouTube import, so the intake is tested too.

| # | Service | YouTube |
|---|---|---|
| 1 | Normal Sunday service | https://www.youtube.com/watch?v=OuXJo09MZWk |
| 2 | Wednesday night | https://www.youtube.com/watch?v=5cVMudHn2iw |
| 3 | Revival service | https://www.youtube.com/watch?v=JIIo4_gc_44 |

**The path inside Priority 1 (agreed 2026-10-17):**

1. **P4-A, "the eyes."** Build only the parts of P4 that let the system see the video and find exact edges: camera cuts, black and frozen frames, words on slides, slide regions, and clean sentence and pause edges. Both picker paths below need these.
2. **The patch to the old picker.** Codex wrote a rule: "a clip must contain one complete message." Try it in the lab on the 3 sermons.
3. **If the patch fails after 2 or 3 rounds, build P5, the new picker.** P5's design lives in Jake's private planning copy. The code base must go private before P5 starts.

**Parked until Phase 1 ends:** P4-B, the "cheap at scale" parts of P4: early deletion of originals, caches, storage leases, big-file upload, PERC. The code is saved on its branch. Nothing is lost.

### Priority 2 — switch on sandbox posting

Jake runs the Facebook sandbox test by hand, with step-by-step guidance. Clips post to the sandbox page. The weekly loop starts: Sunday sermon in, Monday check.

### Priority 3 — 4 clean weeks

Week 1 on the sandbox page. Weeks 2 to 4 on Sunnylane's real page. Phase 1 ends when 4 weeks in a row have no swap and no reject.

## 4. Open questions

None at this time.

## 5. After Phase 1 — a sketch, not a promise (agreed 2026-10-17)

We write the real Phase 2 goal when Phase 1 ends, with what we learned. The direction, in order:

1. **The church check.** Sunnylane gets the one-tap weekly approval. Jake stops checking every clip.
2. **Internal rename.** The repository, the Railway project, and the web address become Pulpit Engine. `app.pulpitengine.com` points at the product.
3. **P4-B, cheap at scale.** Early deletion of originals, caches, PERC for Sunnylane.
4. **Churches 2 to 5.** Pastors Jake knows. Each gets the church check on from day one.
5. **Instagram and TikTok.** After 5 churches post to Facebook every week.
6. **Hands-off posting.** A church may turn off the check after 4 clean weeks of its own.

Pricing stays as it is today, $0, $15, and $29 a month, until church 2 signs up.
