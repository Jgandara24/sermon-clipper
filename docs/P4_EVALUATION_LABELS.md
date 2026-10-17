# P4 evaluation label set

Date: 2026-10-17.
File: [`evaluation/p4-human-labels-2026-10-17.json`](../evaluation/p4-human-labels-2026-10-17.json).
Schema: `p4-human-labels-v1`.

## Source records

The labels come from the 65 `docs/P4_*.json` records in the Codex worktree.
That worktree is branch `codex/p4-sermon-understanding` at commit `7d7191a`.
The branch is local only and is not pushed.
Each record in the label file keeps its path, SHA-256, date, and role.
Six records have no date field, so the file uses their modification date and says so.

46 records carry a top-level Jake decision: reviewer `Jake` or a `userStatement` field.
Three aggregate records hold many more nested Jake decisions:
`P4_LOCAL_BOUNDARY_LABELS.json`, `P4_SECOND_RECORDING_REVIEW.json`, and `P4_VISUAL_FRAME_REVIEW.json`.
Twelve records are context only, such as database authorizations and caption timing reviews.
Every record has a role, so the builder dropped no record silently.

## Recordings

| Recording | Source SHA-256 | Segments | Video |
|---|---|---|---|
| recording-1 | `72a348ef…be642a0` | V1–V4 | h264 854x480, 24000/1001 fps |
| recording-2 | `975a85c0…ba41bf` | C1–C3 | h264 640x360, 30 fps |

Both source checksums matched the local files on 2026-10-17.
Both recordings are approved for local, offline processing only.

## Content

The file holds 69 labels and 192 sampled-frame labels.

| Category | Labels |
|---|---|
| Crop proposal and output verdicts | 24 |
| Service structure (starts, ends, introductions, prayers, drafts) | 13 |
| Visual views (stage-and-audience views, promotional overlays) | 7 |
| Scene changes | 6 |
| Source quality verdicts | 5 |
| Proposed exclusions | 4 |
| Human exclusions | 3 |
| Human keep decisions | 3 |
| Review windows, policy, and source facts | 4 |

Each label states its time provenance.
Only seven labels have a time that Jake typed.
One of them is a scene change: `00:10:36.937339`, "the exact time it goes full stage screen".
Eight interval labels use exact decoded frames that the assistant found and Jake approved.
The assistant found the four stage-view intervals with ffmpeg scene scores.
A scene detector therefore agrees with those edges partly by construction.

## Resolution rule

A later decision overrides an earlier one only within the same scope.
Each label keeps the values it replaced in its `supersedes` list.
For example, the V1 whole-window acceptance gave way to the 00:00:58.980–00:01:03.830 exclusion.
The V2 exclusion start moved from 00:10:37.096 to 00:10:39.721091.
Its approximate end, 00:11:57.029510, became the exact end 00:11:57.019510.
A proposal stays a proposal until a record applies it.

## Stated limits

The five service-structure labels in `P4_LOCAL_BOUNDARY_LABELS.json` are assistant drafts.
Their status is `draft_requires_listening_review`, and their use is diagnostic only.
Sampled-frame labels describe single instants; the gaps between them stay unverified.
No record confirms the absence of a camera cut in any window.
Every label keeps the limits that its record states.

## Privacy

The repository is public.
The label file omits local paths, recording titles, preview files, and quoted sermon speech.
It cites worktree `tmp/` evidence only by relative path and checksum.
Jake's verdict statements are kept verbatim.
