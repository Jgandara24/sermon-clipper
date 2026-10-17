# P4 scene evidence evaluation

Date: 2026-10-17.
Report: [`evaluation/p4-scene-evidence-2026-10-17.json`](../evaluation/p4-scene-evidence-2026-10-17.json).
Labels: [`evaluation/p4-human-labels-2026-10-17.json`](../evaluation/p4-human-labels-2026-10-17.json), SHA-256 `f26ddac1…f30e8`.
See [the label set](P4_EVALUATION_LABELS.md) for label provenance.

## Method

The command `scripts/evaluate-scene-evidence.ts` ran the real P4 pipeline on both recordings.
`buildAnalysisDerivatives` built the 480-line proxy and the analysis FLAC.
`extractVideoEvidence` then ran ffmpeg `scdet` on that proxy.
The settings are the existing local test configuration: `sceneThreshold` 5, `proxyCrf` 18, `ultrafast`.
These values are not production thresholds.
`src/lib/media-regions/scene-change-evaluation.ts` scored the detections at ten thresholds from per-frame scores.
The detection rule matched the `scdet` output exactly at threshold 5 for both recordings.

All processing was local and offline.
The run made no network request, no upload, and no paid call.
It installed no model or dependency.
The script removed each proxy and FLAC after use, and the work directory was empty afterwards.

Tolerances are one frame plus 1 ms (43 ms and 35 ms), 250 ms, and 1000 ms.
A miss is a labeled time with no detection within 1000 ms.
No record confirms the absence of a cut, so the report counts unlabeled detections but no false positives.

## Results at threshold 5

| Group | Events | Within one frame | Missed | Largest error |
|---|---|---|---|---|
| Cut time typed by Jake | 1 | 1 | 0 | 9.339 ms |
| Cut frames observed by the assistant | 2 | 2 | 0 | 0.458 ms |
| Stage-view edges (scene-assisted labels) | 8 | 8 | 0 | 4.333 ms |
| Promotional overlay fades | 6 | 0 | 6 | 275 s to nearest |
| Recording 2 camera-change windows | 3 | 3 of 3 windows detected | 0 | — |

**Jake's cut time.** The label is 00:10:36.937339, "the exact time it goes full stage screen".
The detector reported the frame that starts at 636928 ms (frame time 636.927958 s).
Jake's time is 9.339 ms after that frame starts, inside its 41.7 ms display time.
The full error is therefore the position inside one frame.

**Other cuts.** The wide-shot start at 00:10:36.427458 matched within 0.458 ms.
The V3 camera change at 00:11:30.398042 matched within 0.042 ms.
All eight stage-and-audience edges matched within 4.333 ms.
The assistant found those edges with ffmpeg scene scores, so this agreement is partly circular.

**Misses.** Every promotional overlay fade was missed.
Their strongest frame scores were 0.247 to 1.231, far below threshold 5.
A fade is a gradual change, and `scdet` detects abrupt changes only.
Overlay detection needs a different signal, for example frame-difference accumulation or OCR.

**Recording 2.** Each of the three 20-second windows held exactly one detection.
Those times equal the earlier detector candidates, so this result is circular too.
Jake confirmed only that a camera change occurs in each window.

**Exclusion edges without a stated cause.** These edges are diagnostic only.
The V1 edges were 88 ms and 16 ms after a detection.
The V2 start, 00:10:39.721091, was 40.091 ms after a detection, again inside one frame.
The V2 end and the later framing edges had no detection within 1 s.
Those edges follow speaker movement, not a camera cut.

## Threshold sensitivity

| Threshold | Recording 1 detections | Recording 2 detections | Labeled cuts found |
|---|---|---|---|
| 1 | 95 | 721 | all |
| 2–3 | 57–52 | 40–26 | all |
| 5 | 49 | 26 | all |
| 10 | 45 | 23 | all |
| 15 | 24 | 0 | recording 1: 3 cuts, 1 of 8 view edges; recording 2: none |
| 30 | 2 | 0 | none |

Hard cuts in recording 1 scored 19.3 to 29.7.
Stage-view edges scored 11.8 to 15.4.
Recording 2 cuts scored only 11.9 to 12.7.
Recording 2 is 640x360 and the proxy step scales it up to 854x480.
At threshold 1, recording 2 produced 721 detections, about 10 each minute.
These scores give one data point each; they do not justify a production threshold.

## Unlabeled detections

At threshold 5, recording 1 had 49 detections, and 14 lie within 1 s of a labeled time.
Recording 2 had 26 detections, and 3 lie inside a labeled window.
The other 35 and 23 detections have no label.
They can be real cuts, because the sampled-frame labels show many wide views.
No detection fell in a reviewed camera-cut window without a matching label.

## Cost

| Step | Recording 1 (47 min) | Recording 2 (70 min) |
|---|---|---|
| Proxy and FLAC | 99.5 s | 209.6 s |
| Video evidence | 169.6 s | 302.0 s |

The whole run took 785.8 s wall time on this Mac, with four encoder and filter threads.
`/usr/bin/time -l` reported 872579072 bytes maximum resident set size.

## Limits

Only one cut time in the label set comes from Jake directly.
Ten of the eleven scored cut times came from assistant frame work, eight of them with scene scores.
The three recording 2 windows used earlier detector candidates.
Two recordings cannot establish recall, a threshold, or a production budget.
P4 items 9, 10, 11, 12, 15, and 16 stay blocked on representative labels.
