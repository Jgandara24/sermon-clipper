# Opus Clip Product Specification

Research date: 2026-07-05. Method: observe-only browser session on a live Pro-plan account. No uploads, generations, exports, publishes, or settings changes were performed. This document describes observed product behavior and clearly-labeled inferences for the purpose of building an original, competing product. It contains no proprietary code, assets, or confidential information. Account identifiers and the API key that the app displayed on screen are deliberately excluded.

---

## 1. Executive Summary

**What the product does.** Opus Clip is an AI video repurposing platform. A user uploads or links a long-form video (sermon, podcast, webinar, livestream). The system transcribes it, finds the most shareable moments, cuts them into short vertical clips, ranks each clip with a 0–100 "virality score" plus letter-graded subscores, burns in animated captions and an attention hook, auto-reframes around faces, and lets the user download the clips or schedule them to social platforms.

**Who it is for.** Individual creators (podcasters, streamers), marketers and teams, and — highly relevant to us — churches: the account researched here is a church account whose entire usage history is Sunday-morning sermon processing at 28–84 credits (≈ minutes) per service.

**Primary personas observed/implied.**
- Solo creator repurposing podcasts/streams into Shorts/Reels/TikToks.
- Marketing team member producing branded clips at volume (team seats, brand templates, scheduler).
- Church media volunteer clipping weekly sermons (our target; the product works for this today but has zero church-specific intelligence).

**Core promise.** "Get clips in 1 click": long video in → ranked, captioned, branded, platform-ready vertical clips out, in minutes, with no editing skill required.

**Key value propositions.**
1. Zero-decision default path (one URL paste + one click).
2. Trustable AI curation: every clip carries a score, subscores (Hook/Flow/Value/Trend), and a plain-language "scene analysis" explaining why it was chosen.
3. Text-based editing: the transcript is the timeline; deleting words deletes video.
4. Distribution built in: per-clip scheduling to 6 platforms, calendar, analytics.
5. Cost transparency: credits ≈ minutes of source video; the import screen shows the exact credit price before you commit, and a "Credit saver" timeframe slider lets you process only part of a video.

**AI-driven vs. manual.** AI does: moment selection, scoring, titles/hooks, captions, filler/pause detection, censoring, reframing/tracking, per-segment layout switching, B-roll generation/matching, TTS spoken hooks, emoji/keyword highlighting, transitions. The human does: pick which clips to keep (like/dislike), optionally re-trim via transcript, restyle captions, apply brand, approve export/publish. Every AI output is manually overridable.

**Major limitations observed.**
- Projects/media expire on lower tiers (3-day free, 29-day Starter; 100 GB fixed on Pro) with countdown badges pressuring retention decisions.
- No niche awareness (nothing about sermons, scripture, series, speakers-as-people).
- Approval workflow, roles/permissions, and sub-teams are Business-tier only; no review flow for a volunteer-to-pastor pipeline.
- Editor preview is low-res proxy ("LOW-RES PREVIEW"); final quality only at export.
- Music library had a licensing gap ("Part of instrument music is unavailable due to license expiry") — a reminder that licensed-content dependencies rot.
- Analytics is shallow (views chart; "Advanced analytics coming soon").

**Research confidence.** High for everything in the main navigation, project/clip screens, the full editor, brand templates, asset library, calendar, subscription/pricing, API limits, and the import configuration screen (all directly observed). Medium for behaviors requiring a paid action to see (processing progress UI, export render flow, publish composer with connected accounts). Those are marked Not verified.

---

## 2. Research Scope and Methodology

- **Account state:** Live Pro plan ($29/mo), 600 credits, 1 add-on pack, 1/2 seats used, 2/2 brand templates used, 0 GB / 100 GB storage, 2 existing projects ("Sunday Morning", both ClipAnything model, 33 clips in the inspected project), no social accounts connected, no team members.
- **Areas inspected (direct observation):** Dashboard/home; import workflow config (URL paste up to but not including "Get clips"); project detail incl. filters/sort/search/project menu; clip lightbox incl. scores and all actions; publish-on-social modals to the empty-scheduler state; the entire editor (all 9 right-rail panels, layout menu, tracker, speech cleanup, extend-clip, script tools, export menu, keyboard-shortcut affordance, timeline); brand template builder; asset library; calendar (Beta); social accounts modal; analytics (Beta); subscription; public pricing matrix; API access modal incl. limits; credit usage history; account/workspace menu; notifications/news.
- **Not accessible / not exercised (safety):** starting any processing job; export/render/download; upscale; AI B-roll generation; speech enhancement; AI-hook generation; connecting social accounts; the post composer beyond its empty state; invite/team flows; plan changes; new-user onboarding; failure states of jobs.
- **Actions avoided:** every button in the risk class (Get clips, Export/Download, Upscale, Generate, Save template, Save settings as default, Remove all, Disable it, Refund project, Add account, Invite, all billing buttons).
- **Assumptions are labeled** "Assumption" or "Inferred" throughout. Anything not seen is "Not verified."
- **Confidence classification:** High = directly observed; Medium = inferred from visible UI/pricing matrix; Low = plausible; Not accessible = gated or unsafe to exercise.
- **Research log:** summarized in Appendix 15.1.

---

## 3. Product Map

| Area | Location / Route | Contains | Notes | Confidence |
|---|---|---|---|---|
| Dashboard / Home | `/dashboard` | Import box (URL / Upload / Google Drive + "Get clips in 1 click"), 10-tool row, project tabs (All / Saved / Favorite clips), storage meter, Auto-save + Auto-import (Beta) toggles, project cards with expiry countdowns, tutorial video row, Get support | Placeholder text rotates (Zoom / YouTube / Rumble link), advertising many import sources | High |
| Import config | `/workflow` | URL preview + thumbnail, speech language, optional .SRT upload, credit estimate, copyright confirmation, tabs AI clipping / Don't clip, clip model / genre / clip length dropdowns, auto-hook toggle, prompt-to-clip field, processing-timeframe "Credit saver" slider, Quick presets / My templates, Save settings as default | Appears after pasting a URL; nothing charged until "Get clips" | High |
| Project detail | `/clip/:projectId` | "Original clips (N)" grid/list, virality-sorted, filter (Liked/Disliked/Edited, <90s), sort (Virality/Chronological), ⌘K "find keywords or moments" search, Auto-hook banner, per-clip quick actions (schedule, download, edit), project menu (Refund project, Share project, Download SRT, Download transcript) | Project IDs like `P306221881wh` | High |
| Clip lightbox | modal over project | Rank, editable title, 0–100 score + Hook/Flow/Value/Trend letter grades, scene analysis vs transcript-only toggle, source time range, like/dislike, 9:16 low-res preview with hook card + captions, action rail (Publish, Export XML, Download HD, Upscale ⚡35, Edit clip, AI hook, Enhance speech, Add B-Roll, aspect 9:16/1:1/16:9/4:5, Duplicate), prev/next clip arrows | The score explanation is a first-class UI element | High |
| Editor | `/editor-ux/:projectId.:clipId?clipRank&editType` | Transcript-first script editor, canvas preview, 9 tool panels, per-segment layout system, tracker toggle, timeline (hook track, layout track, filmstrip with trim handles, waveform), undo/redo, explicit Save changes, Export menu | Detailed in §6 | High |
| Brand templates | `/brand-templates-ux` | Template picker, Style (layout/caption/auto-hook), Brand (logo-CTA overlay, intro/outro uploads, music), default AI toggles, live demo preview, Save template | Templates are selectable at import time | High |
| Asset library | (sidebar) | Censored words lists (Beta), Brand vocabulary 0/30 (Beta), custom Fonts 0/2, Media library (Images/Videos/Audio), storage meter | Vocabulary = transcription hints | High |
| Calendar | `/auto-post/calendar` | Month grid, Schedule post, Upload local video, timezone chip; Beta welcome modal | Posting quota language: may change at launch | High |
| Social accounts | modal | Platform connections list (empty), All-platforms filter, Add account | YouTube Channel, TikTok, LinkedIn, Facebook Page, Instagram business/creator, X | High |
| Analytics | `/analytics` (Beta) | Video Performance tab, account-views chart, "Posted through OpusClip" filter, 7-day range picker, blurred "Advanced analytics coming soon" | Data source = connected YT/TikTok | High |
| Subscription | `/subscription` | Plan card (balance, next-cycle credits, packs, seats, brand templates), features list, Compare plans, billing card (price, period, renewal, invoices, cancel) | | High |
| Credit history | `/activity` | Ledger: date, project name, type (ClipProject), status (blank/Canceled), credits consumed | Canceled runs = 0 credits | High |
| API access | modal | Secret key display + copy, limits (900 credits/mo per workspace, 4 concurrent projects, 10-credit minimum per project), docs link | Key shown in plaintext to owner | High |
| Account menu | popover | Account email, Create a team, companion apps (Captions, Thumbnail), Credit usage history, Language, Agent Opus, Logout | | High |
| Notifications | popover "News" | Product announcements (Android app, MCP/agent skill, feature upgrades) | Not job notifications | High |
| Learning/help | external | Learning center (opus.pro), Get support (chat), Help center | Open in new tabs | High |

---

## 4. End-to-End User Journey

1. **Log in.** Email OTP login per pricing matrix (SSO Business-only). Session lands on `/dashboard`. *Not re-verified (already signed in).*
2. **Dashboard.** Intent: start a job or resume work. Sees import box, prior projects with expiry countdowns, credit balance top-right. Failure state: none observed. Opportunity: countdowns create anxiety; a church wants a permanent sermon archive.
3. **Upload / import.** Paste URL (YouTube/Zoom/Rumble/mp4), or Upload (local file ≤10 GB Starter / ≤30 GB Pro), or Google Drive. Route flips to `/workflow` with fetched thumbnail and duration-based credit estimate ("⚡3" for 3:33) — price shown before commitment. Copyright self-certification line displayed. Failure states: invalid URL, oversize file (not exercised).
4. **Configure processing.** Speech language; optional .SRT (bring your own transcript — skips/overrides STT); Clip model (Auto / ClipAnything / ClipBasic); Genre (Auto, Q&A, Commentary, Marketing, Webinar, Motivational speech, Podcast, …) — "we will apply suitable AI curation models"; Clip length buckets; Auto-hook toggle; free-text "Include specific moments" prompt; processing timeframe slider ("Credit saver"); brand template selection (Quick presets / My templates); "Don't clip" mode (caption/reframe the whole video, preserve length); Save settings as default. Then "Get clips in 1 click" starts the job. *Everything up to the button observed; the click itself not exercised.*
5. **Wait for processing.** Not observed live. Inferred from artifacts: project card appears with status; email/none notification unclear. Historical ledger shows jobs are cancelable mid-run (Canceled = 0 credits — generous full refund on cancel).
6. **Review generated clips.** Project page lists ~33 clips for a ~45-min sermon, sorted by virality. Auto-hook banner explains top-10 clips got text hooks. Each card: score, duration, schedule/download/edit icons, AI title.
7. **Understand scores.** Lightbox: 99/100 with Hook A / Flow A / Value A / Trend A-, scene-analysis paragraph, source range, transcript. Like/dislike feedback loop.
8. **Edit a clip.** "Edit clip" opens the editor (§6). Text-first trimming, speech cleanup, extend-from-transcript, styling, layout, brand.
9. **Style captions.** Preset gallery (Karaoke, Beasty, …), font controls, position/animation/lines, AI keyword highlight colors, AI emoji.
10. **Trim or extend.** Trim: select words → delete; or drag filmstrip handles. Extend: "+ Extend a clip" opens full source transcript; click/drag a section → Add.
11. **Reframe.** Aspect 9:16/1:1/16:9(/4:5 in lightbox); Layout Fill/Fit/Split/Three/Four/ScreenShare/Gameplay per segment; global allow-list for AI layout switching; Tracker ON/OFF (face/object tracking); manual crop via canvas transform handles.
12. **Preview.** Low-res proxy playback with all overlays approximated in-browser.
13. **Export/download.** Editor Export menu: Publish on Social / Export XML (Premiere/DaVinci) / Download HD. Lightbox adds Upscale & download (⚡35 credits). *Render/download not exercised.* Pricing: MP4 export limits by tier (3-day/30-day/none), 4K on Business.
14. **Publish/schedule.** Per-clip "Publish on Social" or Calendar-level "Schedule post": select multiple accounts per platform → composer (title/description/hashtags generator per pricing) → schedule. Blocked at empty state without connections; exit confirm protects draft. *Composer not verified.*
15. **Manage library.** Saved/favorite clips tabs, search moments, filters, refund option, SRT/transcript downloads, storage meter, expiries.

---

## 5. Feature Inventory

Format abbreviated per feature for scanability; all fields from the required template are covered collectively. MVP priority is for OUR product (Pulpit Engine-style sermon clipper), not Opus's roadmap.

### 5.1 Account & onboarding
- **Location:** login → dashboard. Entry: clip.opus.pro.
- **Observed:** already-authenticated session; Pro badge in sidebar; workspace avatar + member count; Invite members button; account menu with email, language, logout. Email OTP (pricing matrix); SSO Business-only.
- **States:** signed-in only observed. Locked: SSO/SLM (Business).
- **Connections:** workspace switcher ties to seats/packs.
- **Backend assumption:** user ↔ workspace many-to-many with roles; OTP flow.
- **MVP:** MVP (simple email/OAuth login, single workspace). **Confidence:** High (visible), Medium (auth flows).

### 5.2 Dashboard / home
- **Purpose:** single entry funnel to a paid processing job + resume surface.
- **Controls:** URL input (rotating placeholder: Zoom/YouTube/Rumble), Upload, Google Drive, primary CTA "Get clips in 1 click"; tool row (Long to shorts, AI Captions, Video editor, Enhance speech, AI Sound Effect, AI Reframe, AI B-Roll, AI hook, Upscale, Script to video); tabs All projects (2) / Saved projects (0) / Favorite clips (0); storage meter "0 GB / 100 GB"; toggles Auto-save, Auto-import (Beta); project cards (thumbnail, expiry countdown, title, model subtitle, ⋯ menu); MASTER OPUSCLIP tutorial row; Get support.
- **Notable:** expiry countdown ("17 days before expiring") directly on cards; Auto-import (Beta) suggests watch-a-channel → auto-create projects (pricing: "Auto video import from verified YouTube account").
- **MVP:** MVP (import box + project list). Auto-import: V2 (huge for churches: watch the livestream channel, auto-clip every Sunday). **Confidence:** High; Auto-import behavior Medium.

### 5.3 Upload / import
- **Inputs:** local file (10 GB Starter / 30 GB Pro cap), public URL (YouTube observed fetching title/thumbnail/duration; Zoom/Rumble/mp4 advertised; "10+ sources" on Pro), Google Drive OAuth.
- **Validation:** URL fetch renders a preview card + duration-derived credit cost before any spend; "4k" badge on source; copyright self-certification text.
- **Failure states:** not exercised (invalid URL, private video, oversize).
- **Data created:** SourceVideo + fetched metadata; no charge until confirmed.
- **MVP:** MVP local upload + YouTube link; Drive later. **Confidence:** High for observed, Medium for limits.

### 5.4 Processing configuration (the `/workflow` screen)
- **Options:** Speech language (dropdown, English default); Upload .SRT (optional; bypass/override transcription); Credit usage estimate with ⚡ count; AI clipping vs Don't clip tabs; Clip model: Auto ("let AI choose"), ClipAnything ("smartest, any video"), ClipBasic ("talking videos"); Genre: Auto, Q&A, Commentary, Marketing, Webinar, Motivational speech, Podcast, more below fold; Clip Length: Auto (0–3m), <30s, 30–59s, 60–89s, 90s–3m, 3–5m (5–10m, 10–15m per pricing); Auto hook toggle; "Include specific moments" prompt box with example + "learn more"; Processing timeframe dual-handle slider labeled **Credit saver**; template pickers (Quick presets / My templates with Edit); **Save settings above as default**.
- **Why it matters:** this one screen is the whole product's contract: cost, scope, model, genre-tuned curation, and brand — all before spending.
- **MVP:** MVP (language, length, timeframe, template, sermon-mode genre). Prompt-to-clip V1. **Confidence:** High.

### 5.5 Long-form processing (job lifecycle)
- **Observed indirectly:** ledger rows per run (name, ClipProject type, credits, Canceled status → 0 credits); project cards appear on dashboard; in-project banner after completion.
- **Not verified:** progress %, ETA, queue position, retry UI, notification on finish.
- **Inference:** multi-stage pipeline (probe → transcribe → analyze → cut → preview-render) with cancel-with-full-refund semantics before completion.
- **MVP:** MVP (job status chips + cancel). **Confidence:** Medium.

### 5.6 Clip generation output
- **Observed:** ~33 clips from one sermon; each 25s+ (duration on card); AI titles in click-bait hook grammar ("Prayer is Your FIRST THOUGHT, Not Your Last Resort!"); ranked #1..N by score; top-10 got auto text hooks (banner); duplicates not observed (no two clips shared a range in spot checks).
- **User controls:** like/dislike per clip; hide/save/favorite (Saved projects / Favorite clips tabs); duplicate clip; refund whole project.
- **MVP:** MVP (5–10 clips, titled, ranked, with reasons). **Confidence:** High.

### 5.7 Virality scoring
- **Observed:** integer 0–100 (green), 4 letter-graded subscores: **Hook** (opening grab), **Flow** (narrative continuity), **Value** (substance), **Trend** (topicality). "Scene analysis" paragraph explains the moment; "Transcript only" toggle shows raw text; source time range shown.
- **Assumption:** LLM scoring over transcript windows + engagement-pattern heuristics; Trend likely references topical corpus. Letter grades = banded numeric subscores.
- **MVP:** MVP with our own rubric (see §12). **Confidence:** High (UI), Low (mechanics).

### 5.8 Transcript & captions (data)
- **Observed:** word-level timing (pause chips between words to 0.01s precision; per-word deletion), filler-word detection ("Yeah", "he he" pre-dimmed), full-source transcript browsable with timestamps in Extend modal, SRT + TXT downloads at project level, multi-language transcription (20+ languages, in-app language picker), custom vocabulary (Brand vocabulary 0/30) to bias STT, custom + default censored-word lists feeding Auto censor.
- **MVP:** MVP (word timestamps, SRT export). Vocabulary/censor V1. **Confidence:** High.

### 5.9 Caption styling system
- **Presets:** No captions, Karaoke, Beasty, Deep Diver, Youshaei, Pod P, Think Media, Focus, Mozi, Popline, + animated New set (Blur In, With Backdrop, Soft Landing, Baby Steps, Grow, Breathe, Glitch Infinite, Seamless Bounce).
- **Font tab:** family, color, size (px), weight, italic/underline, Uppercase toggle, stroke (color+px), shadow (color, x, y, blur), AI keywords highlighter toggle + two highlight colors.
- **Effects tab:** Position Auto/Top/Middle/Bottom; Animation None/Bounce/Underline/Box/Pop/Scale/Slide left/Slide up; Lines: Three lines / One line.
- **Tier gates:** watermark on Free; speaker-based caption colors Business-only.
- **MVP:** MVP = 3–4 presets + font/size/color/position/uppercase/highlight. **Confidence:** High.

### 5.10 Editor (summary — full spec §6)
Transcript-first editing, canvas with selectable layers, per-segment layout track, tracker toggle, 9 side panels, timeline with waveform, explicit save + undo/redo, low-res proxy preview, export menu. **MVP:** core subset. **Confidence:** High.

### 5.11 AI enhance one-click suite
Remove filler words; Remove pauses (threshold slider 0.5s default); Auto censor (against censored-word lists); Speech enhancement (10/day Pro, toggle); AI Video B-Roll (3/mo Pro trial, 50/day Business); AI Image B-Roll; Stock Video B-Roll; Auto generate AI hook; AI emoji toggle; AI keywords highlighter toggle; Auto transitions toggle. **MVP:** filler/pause removal. Others V1/V2. **Confidence:** High (existence), Medium (quotas).

### 5.12 AI hook (spoken + text)
- **Observed:** text hook card burned into first seconds (auto-applied to top-10 clips, disableable at project level); an editor panel to write a hook script, pick a **TTS speaker voice** ("Adam", preview play), tone-stability slider, original-audio ducking slider (-50%..+50%), Generate button. AI voice-over quota 20/day (pricing).
- **Insight:** hooks are a first-class growth feature — both visual title-card and synthetic voice-over lead-in.
- **MVP:** text hook card MVP; TTS hook V2. **Confidence:** High.

### 5.13 Reframing / layout / tracking
- Aspect: 9:16 / 1:1 / 16:9 (4:5 seen in lightbox).
- Layouts: Fill, Fit, Split, Three, Four, ScreenShare, Gameplay; **per-time-segment** (layout blocks on the timeline); **Global layout settings** = allow-list governing which layouts the AI may auto-choose.
- Tracker: ON/OFF face/moving-object tracking; genre-specific reframing model (Business); custom reframing (manual crop via canvas handles) Pro+.
- **MVP:** 9:16 + center/face crop + manual crop. Split/Three/Four V1. **Confidence:** High.

### 5.14 B-roll
Upload own; Stock library (searchable, duration-tagged); AI Image B-Roll; AI Video B-Roll (style-matched generation, trial-gated); Create from Prompt. **MVP:** none (V2; churches rarely want meme B-roll — but scripture text cards are our analog). **Confidence:** High (UI).

### 5.15 Audio
Music tab: upload, copyright-free library w/ search + mood chips (All/Liked/Instrumental/…), per-track preview; license-expiry warning banner observed. AI sound effects tab. Original-audio volume control (in AI-hook panel; assumed per-track too). Speech enhancement (quota). **MVP:** original audio only; music V2. **Confidence:** High.

### 5.16 Organization
Projects (= one source video each), Saved projects, Favorite clips, rename (Pro), folders (one default folder Pro; custom folders Business), search across clips ("find keywords or moments" ⌘K — semantic moment search), filters (Liked/Disliked/Edited, length), sort (score/chronological), bulk select mode, per-project share link, storage meter, expiry countdowns. **MVP:** projects + search + favorites. **Confidence:** High.

### 5.17 Export & download
Per clip: Download HD; Upscale & download (⚡35); Export XML for Premiere/DaVinci (Pro); Duplicate. Per project: Download subtitles (SRT), Download transcript (TXT). Bulk export (Pro, pricing). Export limits by tier: Free 3-day/1080p/watermark; Starter 30-day window; Pro/Business no limit, highest res; 4K Business. Render queue/history UI **not verified**. **MVP:** single-clip 1080p MP4 download. **Confidence:** High for options, Medium for flow.

### 5.18 Publishing & scheduling
Connections: YouTube Channel, TikTok (Feed or Inbox), LinkedIn (personal/profile), Facebook Page, Instagram (business/creator), X (⚡ = credit-metered?). Multi-account per platform (Pro). Scheduler modal from clip or Calendar. Calendar Beta with month grid + quota disclaimer. Title/description/hashtag generator (pricing). Composer beyond empty state **not accessible** (no connections). Exit-confirm protects unsaved post config. **MVP:** none (download-first); V1 scheduling metadata; V2 direct posting. **Confidence:** High to the wall, Not accessible beyond.

### 5.19 Team & workspace
Invite members (2 seats/pack up to 4 on Pro; unlimited Business), Create a team in account menu, workspace switcher, sub-teams + member permissions Business-only, share projects with external collaborators (Pro), no comments/approval anywhere on Pro. **MVP:** single workspace; V1 seats; approval flow is OUR differentiator (§12–13). **Confidence:** High (UI + pricing).

### 5.20 Usage limits & monetization
- Credits: 1 credit ≈ 1 minute of source processed (ledger: 28–84/run; import estimate 3 for 3:33; API 15h ≈ 900).
- Plans: Free $0 60cr/mo (1080p, watermark, no editing, 3-day expiry); Starter $15 150cr (editor, 1 template, no watermark, 9:16 only); Pro $29 (yearly $14.5/mo) 3,600cr/yr instant + packs 1–15 (credits & seats scale), 6 social connections, all ratios, scheduler, XML, custom fonts ×2, speech enhancement 10/day, voice-over 20/day, AI B-roll 3/mo trial→50/day Business, 100 GB, limited API, Zapier ≤300cr/mo; Business custom (priority queue, SSO, SOC II, permissions, 4K, CMS, unlimited storage).
- In-editor upsells: Upscale ⚡35; AI B-Roll trials; X posting ⚡.
- **Refund affordances:** cancel-mid-job = 0 credits; "Refund this project" post-hoc.
- **MVP for us:** minutes-based metering with visible pre-job estimate. **Confidence:** High.

### 5.21 Settings / notifications / help
Language picker; no notification-preferences UI found (news feed instead); Get support chat (Intercom per pricing); Learning center + Help external; keyboard-shortcuts panel in editor; companion apps (OpusClip Captions, OpusClip Thumbnail); Agent Opus (AI-agent asset generation, promoted in Media panel and account menu); MCP/agent-skill integration announced in News. **Confidence:** High.

### 5.22 Hidden/contextual
Project ⋯ menu (Refund/Share/SRT/TXT); auto-hook disable banner; per-clip aspect submenu; global-layout allow-list submenu; script filter (Hide deleted parts / Hide non-transcript parts); "Transcript only" toggle; exit-confirm on scheduler; API key modal auto-opens from sidebar icon (displays live secret — a UX safety flaw worth NOT copying). **Confidence:** High.

---

## 6. Editor Specification

### 6.1 Overview
- **Purpose:** turn an AI-cut clip into a publish-ready asset with minimal timeline skill; mental model = "edit the words, the video follows."
- **Entry:** clip lightbox → Edit clip; deep link `/editor-ux/:projectId.:clipId?clipId&clipRank&editType=normal`.
- **Layout:** top bar (back, title, undo/redo, keyboard-shortcuts, Save changes, Export, credits, avatar); left ~45% script editor; center 9:16 canvas; right icon rail (9 panels); bottom collapsible timeline.

### 6.2 Preview player
Play/pause + frame-step transport in timeline bar; timecode `00:00.00 / 00:25.10`; canvas shows hook card + captions + video layer live; low-res proxy watermarked "LOW-RES PREVIEW" in lightbox; aspect switch re-letterboxes canvas; safe zones not observed (gap worth exploiting); render preview = WYSIWYG browser approximation, final = server render.

### 6.3 Timeline
Tracks top→bottom: text/hook overlays (green block w/ label), layout segments ("Fill" blocks; boundaries = layout switches), video filmstrip with in/out trim handles, audio waveform. `+` buttons flank tracks (add track). Zoom slider + magnifiers; Hide timeline toggle; track tools (delete, volume, snapping); playhead ruler in seconds. Drag behaviors not exercised (risk of edit); precision editing exists via pause chips (0.01s granularity shown in chips).

### 6.4 Transcript editing
Script = primary edit surface: word-level tokens; inter-word pause chips showing duration (0.84s, 1.54s…); filler words pre-dimmed; selection toolbar (delete / Edit / + Add); deleting text = cutting video; "Extend a clip" opens full-source transcript (timestamped paragraphs, preview player) — click/drag to append/prepend sections; script search; filter (hide deleted / hide non-transcript); download script. Speaker labels not shown on this single-speaker clip (Not verified). Caption timing implication: transcript edits re-flow captions automatically (inferred; no separate caption re-sync UI exists).

### 6.5 Caption system
As §5.9. Captions render as text layer on canvas; per-word karaoke-style highlight in presets; one-line vs three-line layout; position auto avoids hook card (inferred from Auto option); profanity → Auto censor; filler handling via cleanup; multi-language via processing-time language choice (translation not observed — gap).

### 6.6 Layout & reframing
As §5.13. Layout menu on canvas toolbar; per-segment current-layout + global allow-list; Tracker toggle on canvas toolbar; manual transform (corner handles, crop tool, fit/replace) on selected video layer; background blur/color not observed in Fill/Fit (Not verified — likely inside Fit letterbox options).

### 6.7 Text, graphics, branding
Text panel → Add Text overlay (timeline block + canvas layer). Brand template panel applies template bundle (logo/CTA overlay image, intro/outro bumper videos, caption style, auto-hook style, music, AI defaults). Watermark: none on Pro exports; Free adds one. Progress bars not observed. Emojis via AI emoji toggle.

### 6.8 Audio editing
Music library + upload; AI sound effects; per-clip original-audio volume slider (observed in AI-hook context); waveform visible; mute via track volume; noise reduction = "Speech enhancement" (quota'd); silence removal = pause removal with threshold.

### 6.9 State & persistence
Explicit **Save changes** button (disabled until dirty) + undo/redo stacks; dashboard-level **Auto-save projects** toggle (Pro) — so autosave is plan-gated, manual save otherwise; versioning/multi-tab conflict UI not observed; edits marked with "Edited" filterable flag at project level.

### 6.10 Export from editor
Export menu: Publish on Social / Export XML / Download HD (thumbnail preview shown). No res/fps pickers at this level — simplicity-first; Upscale is the quality upsell elsewhere. Render queue/progress not verified.

---

## 7. AI and Automation Features

| Feature | Input signals | Likely model type | User controls | Output | Failure/override | Confidence |
|---|---|---|---|---|---|---|
| Clip detection | word-timestamped transcript, audio energy, scene cuts, genre | LLM segmenter + heuristics; "genre-specific curation models" per UI copy | model/genre/length pickers, prompt-to-clip, timeframe | candidate ranges | user extends/trims; refund | High (UI) / Low (internals) |
| Virality score + subscores | candidate transcript, hook position, topic | LLM rubric scoring, banded to letters | like/dislike feedback | 0–100 + Hook/Flow/Value/Trend | rerank by chronology; ignore | High/Low |
| Scene analysis | candidate window | LLM summarization | Transcript-only toggle | 1–2 sentence rationale | n/a | High |
| Title/hook text | candidate transcript | LLM w/ clickbait grammar | edit title inline; disable auto-hook | title + burned hook card | manual rewrite | High |
| Spoken AI hook | user/AI script | TTS (multi-voice), stability param | voice, tone slider, ducking, script | voice-over lead-in | regenerate/remove | High (UI) |
| Transcription | audio, language, brand vocabulary | ASR (Whisper-class) w/ custom lexicon | language, .SRT override, vocabulary | word timestamps | edit text; upload SRT | High |
| Filler/pause detection | transcript + gaps | ASR confidence + lexicon; gap threshold | per-instance stepper, threshold slider, Remove all | dimmed tokens, chips | undo; keep | High |
| Auto censor | transcript vs word lists | string/fuzzy match | default+custom lists | bleep/mute (assumed mute) | list editing | High (UI) |
| Face/object tracking | frames | detector+tracker (YOLO/ByteTrack-class) | Tracker toggle; manual crop | crop keyframes | manual reframe | High (toggle) |
| Auto layout switch | shot classification (speakers, screenshare) | scene classifier | global allow-list; per-segment override | layout blocks on timeline | change per segment | High |
| AI B-roll | transcript context; style | stock-search embedding / image-gen / video-gen | pick source type; prompt | inserted media track | delete | High (UI) |
| Keyword highlight/emoji | transcript salience | LLM keyword extraction | toggles + colors | styled tokens / emoji inserts | manual | High |
| Auto transitions | cut points | rules | toggle; manual per-cut | transition fx | manual | High |
| Moment search | all project transcripts | embedding search | ⌘K query | matching clips/moments | n/a | High (UI) |
| Speech enhancement | audio | denoise/dereverb model | toggle (10/day) | cleaned audio | off | High (UI) |

Latency expectations (inferred from credit ≈ minute and "processing speed" as a paid tier axis): pipeline runs at faster-than-realtime with tier-based queue priority. Cost drivers: ASR minutes, LLM tokens (analysis+titles), render minutes, TTS seconds, GPU tracking. Human override exists at every stage — a principle worth copying.

---

## 8. Data Model (inferred architecture — NOT observed implementation)

Notation: key fields only. All tables carry `id, created_at, updated_at`; all workspace-scoped tables carry `workspace_id` (indexed) and access is workspace-membership-checked.

- **User** — email, name, auth_provider, otp_secret?, locale, last_login. Rel: memberships. Lifecycle: soft-delete w/ GDPR purge.
- **Workspace** — name, plan_id, credit_balance, storage_used_bytes, settings_json (default processing config). Rel: members, projects, brand kits. Index: plan.
- **WorkspaceMember** — user_id, workspace_id, role (owner/admin/editor/viewer), invited_by, status. Unique (user, workspace).
- **Role/Permission** — role → permission[] map (publish, export, billing, invite, approve). MVP: enum roles.
- **SubscriptionPlan** — code, price, credits_per_cycle, seat_limit, template_limit, storage_gb, retention_days, feature_flags_json. Workspace→plan + Stripe sub id.
- **UsageLedger** — workspace_id, kind (processing/upscale/voiceover/broll/api), project_id?, credits_delta (+grant/−spend/refund), balance_after, job_id, note. Append-only; index (workspace, created_at). THE billing source of truth.
- **Project** — workspace_id, folder_id?, name, source_video_id, processing_config_json, status, expires_at, is_saved. One source per project (observed).
- **Folder** — workspace_id, name, parent_id? (Business: custom; Pro: one default).
- **SourceVideo** — origin (upload/url/drive), origin_url, filename, duration_s, size_bytes, fps, width/height, storage_key, thumbnail_key, language, srt_override_key?, copyright_ack_at. Index: workspace.
- **VideoAsset** — generic media (b-roll uploads, logos, intros, music, fonts): kind, storage_key, meta_json, duration?, license_note.
- **ProcessingJob** — project_id, type (probe/transcribe/analyze/clip/preview_render/export/upscale/publish), state (queued/running/waiting/succeeded/failed/canceled/retrying/expired), progress_pct, attempt, error_code?, credits_reserved, started_at/finished_at. Index (state, type), (project).
- **Transcript** — source_video_id, language, provider, confidence, full_text (denorm for search).
- **TranscriptSegment** — transcript_id, idx, start_ms, end_ms, text, speaker_id?. Index (transcript, start).
- **WordTimestamp** — segment_id, idx, word, start_ms, end_ms, confidence, is_filler, is_censored. Bulk table; consider JSONB per segment instead at MVP.
- **Speaker** — transcript_id, label, display_name?, face_embedding_ref?. (Church ext: link to Pastor.)
- **GeneratedClip** — project_id, rank, start_ms, end_ms, title, hook_text, summary (scene analysis), status (suggested/kept/hidden), liked (bool?), duplicate_of?. Index (project, rank).
- **ClipScore** — clip_id, total (0–100), subscores_json {hook, flow, value, trend} w/ numeric+letter, model_version.
- **ClipReason** — clip_id, kind (scene_analysis/excerpt), text, source_range. (Can fold into ClipScore.)
- **ClipEdit** — clip_id, editor_state_json (see §BUILD §12), saved_by, version, is_autosave. Latest-wins + limited history.
- **CaptionTrack** — clip_id, language, style_preset_id/style_json, derived_from transcript ranges minus deleted words.
- **CaptionSegment** — track_id, start_ms, end_ms, text, words_json (karaoke timing), line_count.
- **CaptionStyle(Preset)** — name, font, size, weight, colors, stroke, shadow, uppercase, position, animation, lines, highlight_colors, is_builtin.
- **BrandKit/Template** — workspace_id, name, aspect, caption_style_ref, hook_style_json, overlay_asset_id (logo/CTA), intro_asset_id, outro_asset_id, music_asset_id, ai_defaults_json, layout_defaults_json. Limit per plan.
- **LayoutPreset** — enum + params (Fill/Fit/Split/Three/Four/ScreenShare/Gameplay) + allowlist on workspace/template.
- **Overlay** — clip_id, kind (text/image/progress), asset_id?, text?, style_json, start_ms/end_ms, transform.
- **BrollAsset / MusicAsset** — as VideoAsset kinds + provenance (stock/ai/prompt/upload) + license info.
- **ExportJob** — clip_id, preset (hd/upscale/xml), state, output_file_id, credits_charged, error?. Index (workspace, created_at).
- **ExportedFile** — storage_key, bytes, width/height, expires_at (download-link TTL), checksum.
- **PublishingDestination (Integration)** — workspace_id, platform, external_account_id, display_name, oauth_token_encrypted, refresh_token_encrypted, scopes, status, connected_by. Encrypt at rest; never log.
- **ScheduledPost** — clip_id/export_id, destination_id[], caption_text, hashtags, scheduled_at, tz, state (draft/scheduled/posting/posted/failed), external_post_ids_json, approval_id? (church ext).
- **Notification** — user_id, kind (job_done/job_failed/post_published/quota), payload_json, read_at.
- **AuditLog** — workspace_id, actor_id, action, entity, entity_id, meta_json. Append-only (Business feature for them; cheap for us — do it early).
- **ErrorLog** — job_id?, code, message, stack_ref, user_visible bool.

---

## 9. Backend Architecture (proposed for OUR build)

### 9.1 System overview
Web app (Next.js) → API (tRPC/REST on Node) → Postgres (Supabase) + object storage (S3-compatible) + Redis queue (BullMQ) → worker fleet: `media-worker` (FFmpeg probe/extract/render), `asr-worker` (Whisper/Deepgram), `ai-worker` (LLM analysis/scoring/titles), `publish-worker` (social APIs), `notify-worker`. Auth service = Supabase Auth (or Auth.js). All long work is queued; API only enqueues + reads state.

### 9.2 Upload & storage
Direct-to-storage via presigned multipart PUT (browser never proxies through API); finalize webhook → validate (MIME sniff, size, duration probe via ffprobe), reject > plan cap; thumbnail sprite + poster extraction; audio extraction to 16k mono WAV/FLAC for ASR; storage layout `ws/{workspace}/src/{video}/...`, `.../clips/{clip}/...`, `.../exports/...`; lifecycle rules per plan retention; orphan-cleanup job for failed uploads; malware scan optional at MVP (videos are transcoded anyway — treat FFmpeg as the sanitizer, run it sandboxed).

### 9.3 Transcription pipeline
extract audio → language detect (if auto) → ASR with word timestamps + custom vocabulary boost → optional diarization (pyannote/provider) → normalize (punctuation, casing, numerals) → filler tagging (lexicon + confidence) → persist segments/words → index full text (Postgres FTS at MVP; embeddings for moment-search V1). User .SRT upload path: parse, align to audio (forced alignment) or accept as-is with sentence timing. Retries: 3 with backoff; on persistent failure surface "transcription failed" with refund of reserved credits.

### 9.4 AI clipping pipeline
transcript → semantic chunking (complete thoughts; sentence boundaries + max window) → per-genre curation prompt finds candidates (hooks, stories, quotes, emotional peaks, teachable moments; church mode adds scripture/invitation/prayer detectors §12) → boundary snapping to word gaps ≥ threshold (start on a strong sentence) → dedup by IoU over time ranges → deterministic scoring layer (§BUILD §11) + LLM rationale → title/hook/summary generation → persist ranked clips. Human overrides: extend/trim via transcript, reject, re-run with prompt ("include specific moments").

### 9.5 Rendering pipeline
FFmpeg graph per clip: seek-extract source range (stream-copy where possible for preview; re-encode for final) → apply crop keyframes (tracker output as sendcmd/zoompan or per-frame crop filter; MVP: static or 3-keyframe crop) → scale to 1080×1920 → burn captions (libass from styled ASS generated from CaptionTrack — supports karaoke \k tags, stroke, shadow, fade) → overlay hook card + logo (PNG overlays w/ enable=between) → concat intro/outro bumpers → mix music bed w/ sidechain duck under speech → loudnorm to -14 LUFS → H.264 high 1080p + AAC. Preview = 480p fast preset, same graph. Batch export = N jobs. Retry w/ diagnostics (keep filtergraph + stderr in ErrorLog).

### 9.6 Job types & states
Types: upload_finalize, probe, transcribe, analyze, clip_generate, preview_render, final_export, upscale, publish, scheduled_post, cleanup, notify. States: queued → running → (waiting) → succeeded | failed | canceled | retrying | expired. Rules: idempotency key = (type, entity, config-hash); cancel refunds reserved credits (copy Opus's generosity); every state change timestamped + user-visible message on failure.

### 9.7 APIs (REST sketch; final shapes in BUILD §19)
`POST /auth/otp`, `GET/POST /workspaces`, `POST /projects`, `POST /uploads/presign`, `POST /uploads/:id/complete`, `POST /imports/url-preview` (returns duration + credit estimate — copy this), `POST /projects/:id/process`, `GET /projects/:id/jobs`, `GET /projects/:id/clips`, `PATCH /clips/:id` (title/status/like), `GET/PUT /clips/:id/edit-state`, `GET /videos/:id/transcript`, `PATCH /transcripts/words` (bulk delete/restore), `GET/POST /brand-templates`, `POST /clips/:id/exports`, `GET /exports/:id`, `GET/POST /integrations`, `POST /posts` + `GET /calendar`, `GET /usage/ledger`, `GET /notifications`.

### 9.8 Security & privacy
Workspace isolation enforced in a single query-layer guard (never per-endpoint ad-hoc); signed URLs short-TTL for all media; OAuth tokens AES-GCM encrypted w/ KMS key, never logged, scoped minimal; rate limits per user+workspace; audit log on publish/export/billing/delete; redact transcripts from logs; Stripe for payments (no card data touches us); retention: purge media at plan expiry + 30d grace, honor GDPR/CCPA delete; copyright self-certification checkbox on import (copy Opus's line item); abuse: block known-pirated-domain imports, per-day import caps; **prompt-injection**: transcripts and page titles from imported URLs are untrusted input to LLM stages — use system-prompt hardening, output schemas, and never let LLM output trigger side effects (publishing) without human approval. **Do NOT copy Opus's flaw of auto-displaying the API secret on icon click** — require an explicit "reveal key" step + re-auth.

### 9.9 Observability
Structured logs w/ job_id/workspace_id; metrics: queue depth, job duration p95 by type, render failure rate, ASR WER spot checks, credits burned/day, storage growth; traces across enqueue→worker; a jobs dashboard (even internal) day one; per-clip "AI quality" telemetry: like/dislike ratio, % clips edited before export, % exported — these are your model KPIs; cost meters per provider (ASR $/min, LLM $/project, GPU min/render).

---

## 10. Frontend Architecture (proposed)

- **Stack:** Next.js App Router + TypeScript + Tailwind; TanStack Query for server state; Zustand for editor state; no Redux.
- **Routes:** `/login`, `/onboarding`, `/app` (dash), `/app/projects/:projectId` (clip grid), `/app/import` (workflow config), `/app/clips/:clipId/editor`, `/app/templates`, `/app/brand`, `/app/library`, `/app/exports`, `/app/calendar`, `/app/analytics`, `/app/settings{,/workspace,/team,/billing,/integrations}`, `/app/help`. (Mirrors observed IA; Opus's `/clip/:projectId` naming is confusing — use `/projects/`.)
- **Key components:** ImportBox (URL+dropzone+estimate), ProcessingConfigPanel, JobStatusTracker (polling/SSE), ClipCard (score badge, actions), ClipLightbox (score panel + rationale), ScriptEditor (virtualized word tokens, pause chips, selection toolbar), CanvasPreview (layered: video / captions / overlays; CSS-transform approximation), CaptionStylePanel (presets/font/effects tabs), LayoutMenu (+ allow-list), Timeline (tracks, trim handles, zoom), ExportModal, ScheduleModal, UsageMeter, ExpiryBadge, EmptyStates, ErrorBoundary + toasts.
- **Editor state:** single JSON document (BUILD §12) in Zustand; undo/redo via patch stack (immer); autosave debounce 2s → PUT edit-state; dirty flag drives Save button; optimistic UI for metadata edits; conflict: last-write-wins + updated_at guard at MVP.
- **Media preview:** HTML5 video of low-res proxy; captions rendered as DOM overlay synced via requestVideoFrameCallback (accept ±1 frame drift; server render is truth).
- **Upload state:** resumable multipart w/ progress, background-tab safe, failure retry per part.
- **Job updates:** poll 2–5s or SSE channel per project.
- **Validation:** zod schemas shared client/server.
- **Shortcuts:** space=play, ←/→=frame, ⌘Z/⇧⌘Z, ⌘K=search, [ ]=trim set.
- **Accessibility:** full keyboard nav in script editor, ARIA on timeline sliders, contrast-checked caption preview UI, reduced-motion mode.
- **Performance:** virtualize word list (a 45-min sermon ≈ 7k words), thumbnail sprites for filmstrip, lazy panels, transcode previews to ≤480p.

---

## 11. MVP Build Plan

### MVP — "one sermon in, five good clips out" (see BUILD doc for full detail)
Auth (email OTP/OAuth), single workspace, dashboard w/ project list + import box, local upload + YouTube URL w/ pre-job duration+credit estimate, job pipeline w/ visible stages + cancel, transcription w/ word timestamps, AI clip suggestions (5–10) w/ scores + rationale + titles, clip grid + lightbox, editor: transcript trim + extend, caption presets (3–4) + font/position controls, 9:16 export w/ face-or-center crop + burned captions, download, minutes-based usage meter, error surfaces. Acceptance: a non-editor uploads a 45-min sermon and downloads a captioned vertical clip in <15 min without help.

### V1 — competitive
Folders/series, better scoring (feedback loop from like/dislike + edited/exported telemetry), hook/title generation tuned, speaker diarization + speaker-aware crop, face tracking (smoothed), brand templates (logo, colors, intro/outro), more caption styles + keyword highlight, batch export, platform presets (Reels/Shorts/TikTok metadata), moment search, 2-seat teams, Stripe billing + ledger, email notifications, processing dashboard w/ retries.

### V2 — advanced
Direct publishing + scheduling calendar, approval workflow, comments, advanced brand kits, B-roll (scripture text cards first, stock later), music bed w/ ducking, translation/multi-language captions, analytics ingestion, auto-repurpose campaigns (every-Sunday automation), template sharing, public API, enterprise/multi-campus admin.

Each phase's stories, acceptance criteria, dependencies, risks and build order are specified operationally in `BUILD_PROMPT_FOR_CLAUDE_OR_CODEX.md` §23.

---

## 12. Church-Specific Version — "Sermon Clipper" (working name)

### 12.1 Target users
Pastor (final approver, zero tool time), Communications director (owner/admin), Social media volunteer (primary operator, low editing skill), Church media team (multi-user), Multi-campus admin (per-campus brands/accounts), Denominational media team (many churches, template distribution).

### 12.2 Church user journey
Sunday service ends → livestream VOD URL auto-imported (or volunteer pastes link Monday) → system detects sermon boundaries (excludes worship set, announcements, offering) → transcribes w/ church vocabulary (names, "Ebenezer", book names) → generates 5–10 clips scored on a sermon rubric → volunteer reviews, tweaks captions, applies church brand template (logo, series art, pastor name lower-third) → submits for approval → pastor/comms director gets a link, approves or comments on phone → approved clips auto-schedule Tue/Thu/Sat to FB/IG/YT/TikTok → archive tags by series, speaker, book of the Bible, date, topic.

### 12.3 Church-specific AI pipeline
1. **Sermon boundary detection:** classify transcript+audio segments (music vs speech vs crowd); locate sermon start (scripture reading/"turn with me") and end (closing prayer); exclude worship/announcements. 2. **Speaker ID:** diarize; match to known pastor profiles (name + optional voice/face embedding). 3. **Scripture detection:** regex + LLM for refs ("John 3:16", "Romans chapter 8") → normalized ScriptureReference; detect quoted-vs-paraphrased text. 4. **Moment classifiers:** illustration/story, theological quote ("quotable"), gospel invitation, prayer moment, humor, exhortation. 5. **Scoring rubric (deterministic weights + LLM subscores):** Clarity (standalone understandability), Biblical usefulness (teaches a truth), Emotional impact, Shareability, Completeness (no orphaned pronouns), Pastoral tone check (flag out-of-context risk — e.g., a clip that sounds harsh clipped from a longer argument). 6. **Caption generation** w/ scripture references rendered as styled cards (our "B-roll"). 7. **Brand application** (series template). 8. **Approval workflow** (state machine draft→in_review→approved→scheduled→posted, with per-clip comments). 9. **Scheduling** to church cadence presets.

### 12.4 Data model extensions
Church (=workspace subtype: name, denomination?, tz, service times), Campus, MinistryTeam (roles: admin/editor/approver/viewer), Sermon (project subtype: date, campus, series_id, speaker_id, passage_refs[]), SermonSeries (title, artwork asset, date range), Speaker/Pastor (name, title, headshot, voice/face embedding ref), ScriptureReference (book, chapter, verse range, translation, clip_id/sermon_id), ClipApproval (clip_id, state, approver_id, comment thread, decided_at), SocialPost (as ScheduledPost + approval FK), BrandTemplate (series-aware variant), LiturgicalCalendarTag (optional: Advent, Easter, Mother's Day — boosts topical scheduling).

### 12.5 Church MVP
Upload/import sermon video; sermon-segment detection (even v0: "speech after minute X" heuristic + manual boundary confirm); 5–10 vertical clips w/ sermon rubric scores + rationale; auto captions w/ church vocabulary; one church brand template (logo + colors + pastor lower-third); manual approval toggle (approve → unlocks download); export/download; scheduling metadata (suggested post day/time + caption + hashtags) exportable even before direct posting exists.

---

## 13. Product Opportunities and Differentiation

**Pain points observed in Opus (exploitable):**
1. **Content expiry pressure** — cards shout "17 days before expiring." Churches think in archives, not feeds. → Sell permanent sermon archive w/ series taxonomy.
2. **No approval workflow below Business tier** — the volunteer→pastor pipeline is unpriced-for at church budgets. → Approval flow in OUR base tier is the wedge.
3. **Generic scoring** — "Trend" is meaningless for sermons; no scripture/theology awareness. → Sermon rubric + scripture cards are visible, demoable differentiation.
4. **No sermon boundary logic** — churches must manually set the "Credit saver" timeframe to skip worship (and pay to learn this). → Auto boundary detection saves real money and is measurable.
5. **Meme-culture caption presets** (Beasty, Glitch Infinite) read wrong for most churches. → Reverent, readable preset family; series-art templates.
6. **Music licensing rot** observed in-app. → Avoid licensed music at MVP entirely (original audio + optional CCLI-safe beds later).
7. **API key UX flaw** (auto-display on click). → Do secrets right; churches are trust-sensitive.
8. **Low-res-preview trust gap** — users can't judge final quality pre-export. → Fast 720p true-render previews of the first 3 seconds.
9. **Shallow analytics** — no "did this clip bring people to church" lens. → Even simple per-platform view rollups + best-time-for-your-congregation beats their beta.
10. **Anti-clone posture:** different scoring vocabulary, transcript-first-but-reverent UI, archive-not-feed information architecture, approval-centered collaboration, and church-calendar-aware scheduling. We are not "Opus for church" — we are "the sermon archive that publishes itself."

---

## 14. Risks and Open Questions

- **Technical:** face-tracking quality on wide church stage shots (single static camera, podium mic); FFmpeg karaoke-caption fidelity vs browser preview; long-video (90-min service) memory/cost in ASR and LLM windows.
- **AI quality:** clip boundary errors mid-sentence; scoring plausibility (users lose trust after one bad #1 clip); hallucinated scripture references (must verify refs against a Bible text DB before rendering cards).
- **Cost:** ASR + LLM + GPU render per sermon-minute; Opus charges ~1 credit/min at $29/300cr ≈ $0.097/min retail — our COGS must land well under ~3–4¢/min. Upscale/TTS are their margin add-ons; ours can be scripture cards/series art.
- **Social APIs:** Meta/TikTok/YouTube app review timelines, token refresh fragility, per-platform quota; publishing failures need human-visible retry. Facebook Live import is API-fragile.
- **Copyright:** worship music in service VODs (Content ID mutes/blocks clips that include singing — another reason boundary detection matters); sermon illustration quotes from books/movies.
- **Privacy:** congregation members visible in crowd shots (baptisms, prayer moments); minors on camera; transcripts may contain pastoral-care details — retention and consent posture needed.
- **Scaling:** Sunday-morning thundering herd (every church uploads Monday 9am); queue fairness + priority tiers.
- **Billing/usage:** minutes-metering disputes; refunds on bad AI output (Opus's "Refund this project" exists for a reason — budget for it).
- **Product-market:** will churches pay $29+/mo? (Opus's own price anchors this); volunteer turnover means onboarding must be near-zero.
- **Unverified assumptions to close:** processing-progress UX, export render times, publish composer fields, notification channels, onboarding flow, failure-state copy, Quick presets contents, full genre list, 4:5 availability in editor vs lightbox.

---

## 15. Appendix

### 15.1 Research log (condensed)
Session 2026-07-05, ~75 min, Chrome + signed-in Pro account. Order: dashboard → project P306…wh (33 clips) → clip #1 lightbox (score 99) → publish modal chain to empty scheduler → editor deep dive (all panels, tour, layout menu, speech cleanup, extend modal, export menu) → brand templates → asset library → calendar → social modal → analytics → subscription (+ public pricing tab) → API modal (key displayed; not recorded) → credit ledger (/activity) → account menu → import workflow config w/ test YouTube URL (abandoned without processing; nothing charged). Raw notes: `01_PRODUCT_STRATEGY/opus-clip-research-log_v1.md`.

### 15.2 Screen inventory
Dashboard; Workflow (import config, both tabs, 3 dropdowns); Project grid (+filter/sort/menus); Clip lightbox (+aspect menu, publish chain ×3 modals); Editor (script, canvas, 9 panels, layout+global submenu, tracker, cleanup, extend, shortcuts tooltip, filter menu, export menu, 3-step tour); Brand template (+3 drill-ins); Asset library; Calendar (+beta modal); Social connections modal; Analytics; Subscription; Pricing (public); API key modal; Activity ledger; Account menu; News panel.

### 15.3 Feature confidence matrix (abbrev.)
High: nav/IA, clip list/scores/rationale UI, full editor surface, caption system, layout/tracker, brand templates, asset library, calendar shell, pricing/limits, credit ledger, import config. Medium: processing UX, export flow internals, auto-import, diarization presence, quota details. Not accessible: publish composer w/ accounts, team flows, onboarding, failure states, Business features.

### 15.4 Glossary
Credit = 1 source-minute of processing; Project = one source video + its clips; ClipAnything/ClipBasic = curation model tiers; Virality score = 0–100 + Hook/Flow/Value/Trend; Hook = first-3-seconds attention device (text card and/or TTS VO); Layout = per-segment canvas arrangement; Tracker = face/object-following crop; Brand template = reusable style+asset bundle applied at import or edit time; Credit saver = partial-timeframe processing.

### 15.5 Recommended stack (ours)
Next.js/TS/Tailwind; Node API (tRPC) or FastAPI; Postgres (Supabase) + RLS; S3-compatible storage; Redis + BullMQ; FFmpeg + libass workers (containerized, Railway/Fly); WhisperX or Deepgram (word timestamps + diarization); Claude for analysis/scoring/titles w/ JSON schemas; Stripe; Resend for email; OpenTelemetry + Sentry.

### 15.6 Suggested third parties
ASR: Deepgram (speed) or WhisperX self-host (cost). Diarization: pyannote. TTS (V2): ElevenLabs. Stock (V2): Pexels API. Bible text: bolls/api.bible for reference verification. Social: official Meta Graph, YouTube Data, TikTok Content Posting APIs. Upscaling (later): Real-ESRGAN batch.

### 15.7 Testing matrix (high level)
Unit: scoring rubric, boundary snapping, ASS caption generation, credit math. Integration: upload→probe→transcribe on 3 fixture videos (short talking-head, sermon w/ music intro, screenshare). Render: golden-file filtergraph tests + SSIM diff on caption frames. E2E: happy path + each failure (bad URL, oversize, ASR fail, render fail, insufficient credits). Load: 50 concurrent Monday-morning jobs. Security: cross-workspace access fuzz, signed-URL expiry, token encryption.

### 15.8 Accessibility & performance checklists
A11y: keyboard-complete editor, focus rings, ARIA sliders/menus, caption-contrast warnings, reduced motion, screen-reader labels on score badges (not color-only). Perf: <2s dashboard TTI, <5s editor open on 3-year-old laptop, word-list virtualization, proxy videos ≤480p, thumbnail sprites, chunked uploads ≥10 MB parts, render queue p95 < 3× realtime.

---

*Prepared for the Pulpit Engine project. Companion file: `BUILD_PROMPT_FOR_CLAUDE_OR_CODEX.md`.*
