# Pulpit Engine Editorial Standard

**Status:** Frozen 2026-08-11. Binding on every phase of the agentic-editor program and on all
human editing in the product.

This document states what a Pulpit Engine clip is allowed to be. It is deliberately short. It
constrains both the automatic system and the operator, and it does not change when the
implementation changes.

---

## 1. The governing rule

> **Pulpit Engine selects what the pastor said. It does not rewrite what the pastor said through
> editing.**

Everything below follows from that sentence.

## 2. One continuous source range

Every delivered clip is exactly one continuous range of the source video. There is no
concatenation, no stitching, and no assembly of separated moments into a single clip.

This applies to automatic clips and to clips revised by a human operator. There is no elevated
permission that unlocks discontinuous editing.

### Permitted edits

- Start time
- End time
- Crop or reframe
- Captions
- Title
- Hook

### Forbidden edits

- Deleting a word from inside the range
- Deleting a filler word from inside the range
- Deleting a pause from inside the range
- Deleting a repeated phrase from inside the range
- Any other removal from the middle of the range

A clip that fails this rule is not deliverable, regardless of who produced it or how good it looks.
Enforcement lives at the render boundary, not only in the editor, so a hand-crafted or legacy edit
document cannot bypass it.

## 3. Delivery quality is a selection signal, not an editing instruction

Filler words, pauses, coughs, stumbles, drinking water, and repetition all lower a candidate's
rank. None of them authorizes a cut.

The system must prefer:

```
naturally strong moment → clean continuous boundaries → minimal editing → good clip
```

over:

```
mediocre moment → aggressive editing → acceptable clip
```

When a candidate has a delivery problem, the correct response is to consider whether a different
candidate communicates an equally strong or stronger idea more cleanly — not to repair the weak one.

A consequence, accepted deliberately: automatic clips keep every "um" and will feel less edited
than heavily produced competitor output. Faithfulness outranks polish.

## 4. What a good clip looks like

Selection and review both rank these qualities:

- A strong opening hook
- One complete thought
- Clean start and ending boundaries
- Theological and contextual completeness
- Low filler density
- No unnecessary silence
- Little repetition
- Strong vocal delivery
- The pastor visible on screen
- No full-screen slide covering the speaker
- No forbidden service content
- Topical diversity across the candidate pool

## 5. Forbidden service content

A sermon livestream contains material that must never appear in a delivered clip. Detection
categories are facts about the media; the policy that acts on them is versioned in code.

Never deliverable: worship, announcements, prayer, baptism, altar call, and other non-sermon
service content.

Slides are handled by position, not by presence:

- A full-screen slide in the **middle** of a candidate makes that candidate ineligible. It cannot be
  revised away, because removing it would require an internal cut.
- A short slide at the **edge** of a candidate may be excluded by moving the start or end boundary,
  but only when the resulting boundaries still contain a complete thought.

When content is ambiguous, the system escalates once. If it remains ambiguous, the sermon goes to a
human exception queue. It is never delivered on a guess.

## 6. Fewer clips, never weaker clips

The system returns up to a configured number of candidates. It returns fewer when the sermon does
not contain more good moments.

Padding the list with weak clips to reach a target is forbidden. A thin result is a correct result,
not a processing failure.

## 7. Human review is the standard of record

A delivered clip must have been accepted by a reviewer against the **exact file** that will publish
— the exact clip, the exact edit version, and the exact rendered output.

Any material change invalidates a prior acceptance. A new edit, a new render, a replacement, or a
changed selection all require a fresh decision.

The three decisions are `ACCEPT`, `REVISE`, and `REPLACE`. A review may carry any number of
feedback items, and more may be added later.

Reviewers do not see the selector's scores, subscores, or rationale. Those are anchors that would
bias the judgment being recorded. Reviewers do see the machine-generated title and hook, clearly
labeled as fields under review.

## 8. Scheduling

- Clips are never posted on Sunday.
- Posting days are derived from each church's configured service days. Sunday and Wednesday are
  common defaults, not rules.
- A special or unrecognized service is analyzed, and its clips are available as reserve, but it is
  not scheduled automatically.
- A posting date that passes without an eligible clip is marked missed. Remaining clips keep their
  original dates. Nothing shifts forward and nothing spills into the following week.

## 9. Precedence

Where this document and any implementation plan disagree, this document governs. Where a future
product phase intends to relax a rule here — internal cuts being the obvious candidate — it
requires an explicit, dated decision entry that supersedes the relevant section, not a quiet
implementation change.
