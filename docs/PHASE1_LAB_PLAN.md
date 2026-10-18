# Phase 1 lab plan

Date: 2026-10-17. Status: proposed. Jake has not approved it yet. No code from this plan is written.
This plan serves Priority 1 in [the founder brief](FOUNDER_BRIEF.md): 3 Sunnylane sermons, 18 of 18 clips pass.
Words follow [CONTEXT.md](../CONTEXT.md).

## 1. What is true today

I checked the code on 2026-10-17. Here is what we have and do not have.

**The old picker runs today.** It reads only the words of the sermon. It never looks at the video. It picks up to 18 candidates and keeps 6. Your own test scored it 1 of 6.

**The picker patch does not run yet.** Codex built the "complete message" rule and 424 tests for it. But three parts are missing:

1. **No live connection to the model.** The patch has a "disconnected" adapter. It has never made a real call.
2. **No automatic evidence.** The patch needs a list of "allowed" and "excluded" time ranges, and a list of silences, for the exact transcript. Today a person must type those by hand. Without them, every clip is refused.
3. **The budget is too small for a full sermon.** The caps cover about 30 minutes of source. A Sunnylane sermon is 45 to 70 minutes.

If you switch the patch on today, the run stops with an error. Nothing is picked. That is by design. It fails closed.

**The eyes exist as parts, not as a whole.** The P4 branch has working parts: camera-cut detection, black and frozen frame detection, silence detection, frame fingerprints, reading text on a frame, and a table for "slide" and "preacher visible" regions. The export already refuses a clip that touches a "slide" region. But **nothing decides "this moment is a slide, not the preacher."** No detector writes to that table. And none of these parts is connected to the picker.

**Local models did not pass review.** Five small models were tested for faces, people, text, speech, and words. None was approved. None was tested on real sermon footage.

**Showing you a clip.** The app can export a clip as a captioned MP4 through the worker. There is no page that shows 6 clips with their words and a pass/fail button. That is new, small work.

## 2. Where the lab runs

The lab needs: a database, the worker, ffmpeg, yt-dlp, and keys for transcription and the model.

| Option | Good | Bad |
|---|---|---|
| **A. Your Mac** | YouTube import works from a home internet address with no proxy. The setup guide exists in the README. No new cost. | Today the Mac has 5.1 GB free and Docker is off. We need 15 GB free. Three sermons at 720p take about 3 GB. |
| **B. A separate Railway "lab" copy** | Always on. No disk problem. | Needs the residential proxy for YouTube. Costs a few dollars a month. Takes a session to set up. |

**Recommendation: Option A.** Free the disk to 15 GB and start Docker. If the Mac cannot get there, we do Option B. The lab never touches production data.

## 3. What we build, in order

### Step 1 — the review sheet (small, first)

One page per sermon. For each of the 6 clips: the captioned MP4, the start and end time, the words, and buttons: **Pass**, or **Fail** with the test it failed (1 start/end, 2 non-sermon content, 3 slide on screen, 4 not engaging). Your marks save to a labels file. That file becomes the record for Phase 1 and the training data for later.

The sheet reuses the existing export path for the MP4s. It adds one small read-only query for the words.

### Step 2 — first run with the old picker (baseline)

Run lab sermon 1 (the normal Sunday) through the old picker. You judge 6 clips on the review sheet. This gives three things fast: proof the lab works end to end, a baseline score, and your first labels on a real Sunnylane sermon. It costs about $0.50 and 10 minutes of machine time.

### Step 3 — the camera check (P4-A for Phase 1)

This is the new piece that serves test 3, "the video shows the preacher the whole time."

1. Take one frame every 2 seconds across each candidate clip.
2. Group frames that look the same. The frame fingerprint code exists. A 60-second clip usually becomes 5 to 10 distinct pictures.
3. Ask the vision model one question per distinct picture: "Is this the preacher, a slide, song words, a logo, or something else?"
4. Save the answer as a region fact in the existing table. The export already refuses a clip that touches a slide region. We add the same refusal to the picker.
5. Use the existing camera-cut detector so a clip never starts or ends within half a second of a camera cut.

Why a vision model and not a local model: no local model passed review. At Phase 1 size, the vision model is cheap. My estimate is 100 to 200 pictures per sermon, under $0.50. We measure the real number in the first run. The plan's cost cap is $1.50 per sermon.

What the camera check cannot do yet: catch a small graphic that fades in over the preacher. The camera-cut detector missed all 6 of those on your two labeled recordings. The vision model sees the whole picture, so it should catch them. We will know after Step 3.

### Step 4 — make the picker patch runnable

1. **Live connection.** Connect the patch to the same model connection the old picker already uses.
2. **Automatic evidence.** Build the "allowed" and "excluded" ranges from the camera check (Step 3) and the existing sermon keyword filter. Build the silence list from the existing silence detector.
3. **Budget for a full sermon.** Resize the caps for 75 minutes. Codex's own tests show the current caps truncate. This may need a design change, not just bigger numbers.

### Step 5 — the three sermons

Run all 3 lab sermons through the patched picker with the camera check. You judge 18 clips. If any fails, we fix and run all 3 again. We stop when 18 of 18 pass.

### Step 6 — exact edges (only if Step 5 shows edge failures)

The transcript boundary code finds silences, sentence ends, and paragraph ends. It exists as a pure function. We snap each start and end to the nearest clean boundary. We build this only if your marks show "starts or ends oddly" failures after Step 5.

## 4. What you do

1. Free the Mac disk to 15 GB and start Docker. Or tell me to set up Option B.
2. After Step 2: judge 6 clips. About 15 minutes.
3. After Step 5: judge 18 clips. About 45 minutes per round.

## 5. Which code the lab runs

The lab runs from the P4 branch plus the Codex work (PR #112). Everything the lab needs is there. Production stays on `main`. When the lab passes, we take only the pieces Phase 1 proved and bring them to `main` in small pull requests. The rest of P4 stays parked.

## 6. Cost and time per sermon in the lab (estimates, to be measured in Step 2)

| Item | Estimate |
|---|---|
| Download from YouTube | $0 |
| Transcription | $0.10 to $0.30 |
| Old picker | $0.16 (measured) |
| Camera check | under $0.50 |
| Patched picker | unknown; the caps allow up to 60 model calls |
| Machine time | 6 minutes for the pipeline, plus 3 to 5 minutes of video scanning per hour of sermon |

## 7. Risks, in plain words

- The patch's budget design may not fit a full sermon. Fixing it may take longer than the other steps.
- The vision model may miss a subtle overlay. Step 3 tells us.
- Word times from the transcription service are estimates. A start or end can be off by a fraction of a second. Step 6 covers this if it shows.
- The model's verdict "this is a complete message" is a judgment, not proof. Your marks are the proof.

## 8. What we do not do in the lab

No early deletion of originals. No caches or storage leases. No range exports. No PERC. No Pulpit Engine merge. No P5. No change to production.
