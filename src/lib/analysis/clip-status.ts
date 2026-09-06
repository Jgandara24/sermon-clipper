import { GeneratedClipStatus } from "@prisma/client";

/**
 * The status analysis writes for a candidate it retains.
 *
 * **The enum name reads backwards from how this codebase uses it.** `SUGGESTED` sounds like "the
 * selector proposed this and it was not kept", and `KEPT` sounds like the retained set. The
 * opposite is true: `analyze.ts` builds a local list called `kept` — the candidates that survived
 * selection — and writes every one of them as `SUGGESTED`. Nothing in production ever writes
 * `KEPT`; the only writer is a manual `PATCH /api/clips/[id]` that no surface calls.
 *
 * That misreading has now cost two slices. P3.1's candidate pool excluded `SUGGESTED` and emptied
 * every church's project page. `reserve-policy.ts` promoted only `KEPT` and would have found no
 * eligible reserve for any real sermon, emptying a slot on every replacement.
 *
 * So the fact lives here once, and both the writer and the policy that reads it point at this
 * constant rather than at a status somebody remembered. A test binds them together.
 */
export const ANALYSIS_RETAINED_CLIP_STATUS = GeneratedClipStatus.SUGGESTED;

/**
 * Every status that means "a retained candidate nothing has moved out of the pool".
 *
 * `HIDDEN` and `SUPERSEDED` are the two a person or a replacement puts a clip into, and they are
 * the two that are absent here.
 */
export const RETAINED_CLIP_STATUSES: readonly GeneratedClipStatus[] = [
  ANALYSIS_RETAINED_CLIP_STATUS,
  GeneratedClipStatus.KEPT,
];
