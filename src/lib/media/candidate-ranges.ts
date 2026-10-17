import { createHash } from "node:crypto";
import { z } from "zod";
import { sha256Schema, sourceIntervalSchema } from "@/lib/media-artifacts/types";

import { exactTimeMsSchema, normalizeTimeMs, compareTimeMs, subtractTimeMs, addTimeMs, type ExactTimeMs } from "./exact-time";

export const CANDIDATE_RANGE_PLAN_VERSION = "candidate-range-plan-v2";
const timeMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const candidateSchema = z.object({
  candidateId: z.string().min(1), sourceInterval: sourceIntervalSchema,
}).strict();
export const candidateRangeRequestSchema = z.object({
  sourceSha256: sha256Schema,
  sourceDurationMs: timeMs.positive(),
  candidates: z.array(candidateSchema).min(1).max(10000),
  handles: z.object({ beforeMs: timeMs, afterMs: timeMs }).strict(),
  // Keyframes must use the same normalized source clock as candidate intervals.
  keyframeTimesMs: z.array(exactTimeMsSchema).min(1),
}).strict();
export type CandidateRangeRequest = z.infer<typeof candidateRangeRequestSchema>;
export type PlannedCandidateRange = {
  sourceInterval: { startMs: ExactTimeMs; endMs: ExactTimeMs };
  candidateIds: string[];
};

/** Planning is not stream-copy safety or media-quality proof. Keyframes alone cannot prove closed GOPs. */
export function planCandidateRanges(input: CandidateRangeRequest) {
  const request = candidateRangeRequestSchema.parse(input);
  const { sourceDurationMs: duration } = request;
  const keys = request.keyframeTimesMs.map(normalizeTimeMs);
  for (let i = 0; i < keys.length; i++) {
    if (compareTimeMs(keys[i], duration) >= 0 || (i > 0 && compareTimeMs(keys[i], keys[i - 1]) <= 0)) {
      throw new Error("CANDIDATE_RANGE_INVALID_KEYFRAME_CLOCK");
    }
  }
  const ids = new Set<string>();
  const candidates = request.candidates.map(candidate => {
    if (ids.has(candidate.candidateId)) throw new Error("CANDIDATE_RANGE_DUPLICATE_CANDIDATE");
    ids.add(candidate.candidateId);
    if (candidate.sourceInterval.endMs > duration) throw new Error("CANDIDATE_RANGE_OUTSIDE_SOURCE");
    const { startMs, endMs } = candidate.sourceInterval;
    // Subtraction avoids overflow when callers supply very large handles.
    const handledStart = startMs - Math.min(startMs, request.handles.beforeMs);
    const handledEnd = endMs + Math.min(duration - endMs, request.handles.afterMs);
    const startIndex = upperBound(keys, handledStart) - 1;
    if (startIndex < 0) throw new Error("CANDIDATE_RANGE_NO_PRECEDING_KEYFRAME");
    const endIndex = lowerBound(keys, handledEnd);
    return { candidateId: candidate.candidateId, requestedInterval: candidate.sourceInterval,
      handledInterval: { startMs: handledStart, endMs: handledEnd },
      paddedInterval: { startMs: keys[startIndex], endMs: keys[endIndex] ?? duration } };
  }).sort((a, b) => compareTimeMs(a.paddedInterval.startMs, b.paddedInterval.startMs) ||
    compareTimeMs(a.paddedInterval.endMs, b.paddedInterval.endMs) || compareIds(a.candidateId, b.candidateId));

  const ranges: PlannedCandidateRange[] = [];
  for (const candidate of candidates) {
    const previous = ranges.at(-1);
    if (previous && compareTimeMs(candidate.paddedInterval.startMs, previous.sourceInterval.endMs) <= 0) {
      previous.sourceInterval.endMs = compareTimeMs(previous.sourceInterval.endMs, candidate.paddedInterval.endMs) >= 0
        ? previous.sourceInterval.endMs : candidate.paddedInterval.endMs;
      previous.candidateIds.push(candidate.candidateId);
    } else {
      ranges.push({ sourceInterval: { ...candidate.paddedInterval }, candidateIds: [candidate.candidateId] });
    }
  }
  for (const range of ranges) range.candidateIds.sort(compareIds);
  const rangeIndices = new Map(ranges.flatMap((range, index) => range.candidateIds.map(id => [id, index] as const)));
  const coverage = candidates.map(candidate => {
    const rangeIndex = rangeIndices.get(candidate.candidateId)!;
    const range = ranges[rangeIndex];
    return { ...candidate, rangeIndex,
      // A future extracted artifact must independently prove a zero-based mapping before using these offsets.
      plannedRelativeInterval: {
        startMs: subtractTimeMs(candidate.requestedInterval.startMs, range.sourceInterval.startMs),
        endMs: subtractTimeMs(candidate.requestedInterval.endMs, range.sourceInterval.startMs),
      } };
  }).sort((a, b) => compareIds(a.candidateId, b.candidateId));
  const totalRangeDurationMs = ranges.reduce<ExactTimeMs>((sum, range) => addTimeMs(sum, subtractTimeMs(range.sourceInterval.endMs, range.sourceInterval.startMs)), 0);
  const plan = { version: CANDIDATE_RANGE_PLAN_VERSION, sourceSha256: request.sourceSha256,
    sourceDurationMs: duration, handles: request.handles, keyframeTimesMs: keys, ranges, coverage, totalRangeDurationMs };
  return { ...plan, planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}

function compareIds(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function lowerBound(values: ExactTimeMs[], target: ExactTimeMs) {
  let low = 0, high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareTimeMs(values[middle], target) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}
function upperBound(values: ExactTimeMs[], target: ExactTimeMs) {
  const index = lowerBound(values, target);
  return index < values.length && compareTimeMs(values[index], target) === 0 ? index + 1 : index;
}
