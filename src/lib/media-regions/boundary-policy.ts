import { z } from "zod";
import { sha256Schema, sourceIntervalSchema } from "@/lib/media-artifacts/types";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { mediaRegionIdentityKey, mediaRegionSchema } from "./types";

export const SLIDE_BOUNDARY_POLICY_VERSION = "slide-boundary-policy-v1";
export const slideBoundarySettingsSchema = z.object({
  maxEdgeTrimMs: z.number().int().nonnegative().safe(),
  slideClearanceMs: z.number().int().nonnegative().safe(),
  minimumClipMs: z.number().int().positive().safe(),
}).strict();
const timeSchema = z.number().int().nonnegative().safe();
export const slideBoundaryInputSchema = z.object({
  sourceVideoId: z.string().uuid(), sourceSha256: sha256Schema,
  candidate: sourceIntervalSchema,
  requiredSpeech: z.array(sourceIntervalSchema).min(1),
  safeStartsMs: z.array(timeSchema).min(1), safeEndsMs: z.array(timeSchema).min(1),
  facts: z.array(mediaRegionSchema), settings: slideBoundarySettingsSchema,
}).strict();
type Interval = z.infer<typeof sourceIntervalSchema>;
const overlaps = (a: Interval, b: Interval) => a.startMs < b.endMs && b.startMs < a.endMs;
const forbidden = new Set(["WORSHIP", "ANNOUNCEMENT", "PRAYER", "BAPTISM", "ALTAR_CALL", "OTHER_SERVICE_CONTENT", "VERSE_SLIDESHOW"]);

/** Local boundary proposal only. It never approves semantic completeness or missing detector coverage. */
export function applySlideBoundaryPolicy(value: z.infer<typeof slideBoundaryInputSchema>) {
  const input = slideBoundaryInputSchema.parse(value);
  for (const points of [input.safeStartsMs, input.safeEndsMs]) {
    if (points.some((time, index) => (index > 0 && time <= points[index - 1]) ||
      time < input.candidate.startMs || time > input.candidate.endMs)) throw new Error("SLIDE_BOUNDARY_SAFE_POINTS_INVALID");
  }
  if (input.requiredSpeech.some(span => span.startMs < input.candidate.startMs || span.endMs > input.candidate.endMs)) {
    throw new Error("SLIDE_BOUNDARY_REQUIRED_SPEECH_OUTSIDE_CANDIDATE");
  }
  if (input.facts.some(fact => fact.sourceVideoId !== input.sourceVideoId || fact.sourceSha256 !== input.sourceSha256)) {
    throw new Error("SLIDE_BOUNDARY_SOURCE_MISMATCH");
  }
  const facts = [...input.facts].sort((a, b) => mediaRegionIdentityKey(a).localeCompare(mediaRegionIdentityKey(b)));
  if (new Set(facts.map(mediaRegionIdentityKey)).size !== facts.length) throw new Error("SLIDE_BOUNDARY_DUPLICATE_FACT");
  const evidence = { version: SLIDE_BOUNDARY_POLICY_VERSION,
    inputSha256: rangeEvidenceSha256({ ...input, facts }), settings: input.settings,
    sourceVideoId: input.sourceVideoId, sourceSha256: input.sourceSha256, original: input.candidate,
    factIdentities: facts.map(mediaRegionIdentityKey), semanticApproval: "not_evaluated" as const };
  const reject = (reason: string) => ({ decision: "REJECT" as const, reason, sourceInterval: null, evidence });
  const relevant = facts.filter(fact => overlaps(fact.sourceInterval, input.candidate));
  if (relevant.some(fact => forbidden.has(fact.kind))) return reject("FORBIDDEN_SERVICE_CONTENT");
  if (relevant.some(fact => fact.kind === "AMBIGUOUS")) return reject("AMBIGUOUS_REGION");
  const slides = relevant.filter(fact => fact.kind === "FULLSCREEN_SLIDE")
    .map(fact => ({ startMs: Math.max(fact.sourceInterval.startMs, input.candidate.startMs),
      endMs: Math.min(fact.sourceInterval.endMs, input.candidate.endMs) }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: Interval[] = [];
  for (const slide of slides) {
    const previous = merged.at(-1);
    if (previous && slide.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, slide.endMs);
    else merged.push({ ...slide });
  }
  let startMs = input.candidate.startMs, endMs = input.candidate.endMs;
  if (merged.some(slide => slide.startMs <= startMs && slide.endMs >= endMs)) return reject("SLIDE_COVERS_CANDIDATE");
  if (merged.some(slide => slide.startMs > startMs && slide.endMs < endMs)) return reject("MIDDLE_SLIDE");
  const first = merged[0], last = merged.at(-1);
  if (first?.startMs === startMs) {
    const target = first.endMs + input.settings.slideClearanceMs;
    if (!Number.isSafeInteger(target)) return reject("NO_SAFE_START");
    const selected = input.safeStartsMs.find(time => time >= target);
    if (selected === undefined) return reject("NO_SAFE_START");
    startMs = selected;
  }
  if (last?.endMs === endMs) {
    const target = last.startMs - input.settings.slideClearanceMs;
    const selected = input.safeEndsMs.findLast(time => time <= target);
    if (selected === undefined) return reject("NO_SAFE_END");
    endMs = selected;
  }
  if (startMs - input.candidate.startMs > input.settings.maxEdgeTrimMs ||
    input.candidate.endMs - endMs > input.settings.maxEdgeTrimMs) return reject("EDGE_TRIM_LIMIT_EXCEEDED");
  if (endMs - startMs < input.settings.minimumClipMs) return reject("CLIP_TOO_SHORT");
  const interval = { startMs, endMs };
  if (input.requiredSpeech.some(span => span.startMs < startMs || span.endMs > endMs)) return reject("REQUIRED_SPEECH_REMOVED");
  if (merged.some(slide => overlaps(slide, interval))) return reject("MIDDLE_SLIDE");
  return { decision: startMs === input.candidate.startMs && endMs === input.candidate.endMs ? "UNCHANGED" as const : "TRIMMED" as const,
    reason: "BOUNDARY_CHECK_PASSED", sourceInterval: interval, evidence };
}
