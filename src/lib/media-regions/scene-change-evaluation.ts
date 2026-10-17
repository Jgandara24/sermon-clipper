import { z } from "zod";

export const SCENE_CHANGE_EVALUATION_VERSION = "scene-change-evaluation-v1";
const microseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const sceneChangeEventSchema = z.object({
  id: z.string().min(1), group: z.string().min(1),
  timeUs: microseconds.optional(), windowUs: z.object({ startUs: microseconds, endUs: microseconds }).strict().optional(),
}).strict().refine(event => (event.timeUs === undefined) !== (event.windowUs === undefined) &&
  (!event.windowUs || event.windowUs.endUs > event.windowUs.startUs), "An event needs one time or one nonempty window.");
export const sceneChangeEvaluationSchema = z.object({
  events: z.array(sceneChangeEventSchema).min(1),
  // Every decoded frame with its detector score. Detections at each threshold derive from these scores.
  frames: z.array(z.object({ timeMs: z.number().nonnegative(), score: z.number().min(0).max(100) }).strict()).min(2),
  thresholds: z.array(z.number().min(0).max(100)).min(1),
  tolerancesMs: z.array(z.number().positive()).min(1),
  // Windows that a person reviewed for camera cuts without confirming their absence.
  reviewedWindowsUs: z.array(z.object({ id: z.string().min(1), startUs: microseconds, endUs: microseconds }).strict()),
}).strict();
export type SceneChangeEvaluationInput = z.infer<typeof sceneChangeEvaluationSchema>;

const round = (value: number) => Math.round(value * 1000) / 1000;
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Measures detector times against labeled times. It reports misses and unlabeled detections; it never sets a threshold. */
export function evaluateSceneChanges(value: SceneChangeEvaluationInput) {
  const input = sceneChangeEvaluationSchema.parse(value);
  if (input.frames.some((frame, index) => index > 0 && frame.timeMs <= input.frames[index - 1].timeMs)) {
    throw new Error("SCENE_EVALUATION_FRAMES_UNORDERED");
  }
  if (new Set(input.events.map(event => event.id)).size !== input.events.length) throw new Error("SCENE_EVALUATION_EVENT_DUPLICATE");
  const largest = Math.max(...input.tolerancesMs);
  const periods = input.frames.slice(1).map((frame, index) => frame.timeMs - input.frames[index].timeMs);
  const durationMinutes = (input.frames.at(-1)!.timeMs - input.frames[0].timeMs) / 60000;
  const runs = [...new Set(input.thresholds)].sort((a, b) => a - b).map(threshold => {
    const detections = input.frames.filter(frame => frame.score >= threshold);
    const events = input.events.map(event => {
      if (event.windowUs) {
        const inside = detections.filter(d => d.timeMs * 1000 >= event.windowUs!.startUs && d.timeMs * 1000 < event.windowUs!.endUs);
        return { id: event.id, group: event.group, detected: inside.length > 0,
          detectionsMs: inside.map(d => ({ timeMs: d.timeMs, score: round(d.score) })) };
      }
      const labelMs = event.timeUs! / 1000;
      let nearest: (typeof detections)[number] | undefined;
      for (const d of detections) if (!nearest || Math.abs(d.timeMs - labelMs) < Math.abs(nearest.timeMs - labelMs)) nearest = d;
      const errorMs = nearest ? round(nearest.timeMs - labelMs) : null;
      return { id: event.id, group: event.group, nearestDetectionMs: nearest?.timeMs ?? null,
        nearestScore: nearest ? round(nearest.score) : null, signedErrorMs: errorMs,
        matchedWithinMs: Object.fromEntries(input.tolerancesMs.map(t => [t, errorMs !== null && Math.abs(errorMs) <= t])),
        // A miss means no detection within the largest tolerance.
        missed: errorMs === null || Math.abs(errorMs) > largest };
    });
    const groups = [...new Set(input.events.map(event => event.group))].map(group => {
      const members = events.filter(event => event.group === group);
      const points = members.filter((event): event is Extract<typeof event, { signedErrorMs: number | null }> => "signedErrorMs" in event);
      const errors = points.flatMap(event => event.signedErrorMs === null ? [] : [Math.abs(event.signedErrorMs)]);
      const windows = members.filter(event => "detected" in event) as { detected: boolean }[];
      return { group, events: members.length,
        pointEvents: points.length, windowEvents: windows.length, windowsDetected: windows.filter(w => w.detected).length,
        matchedWithinMs: Object.fromEntries(input.tolerancesMs.map(t => [t, points.filter(event => event.matchedWithinMs[t]).length])),
        missed: points.filter(event => event.missed).length,
        medianAbsoluteErrorMs: median(errors), maximumAbsoluteErrorMs: errors.length ? Math.max(...errors) : null };
    });
    const labeledMs = input.events.flatMap(event => event.timeUs === undefined ? [] : [event.timeUs / 1000]);
    const reviewedWindows = input.reviewedWindowsUs.map(window => {
      const inside = detections.filter(d => d.timeMs * 1000 >= window.startUs && d.timeMs * 1000 < window.endUs);
      const unlabeled = inside.filter(d => !labeledMs.some(label => Math.abs(d.timeMs - label) <= largest));
      return { id: window.id, detections: inside.length, unlabeledDetectionsMs: unlabeled.map(d => d.timeMs) };
    });
    return { threshold, detections: detections.length, detectionsPerMinute: round(detections.length / durationMinutes),
      groups, events, reviewedWindows };
  });
  return { evaluationVersion: SCENE_CHANGE_EVALUATION_VERSION, frameCount: input.frames.length,
    firstFrameMs: input.frames[0].timeMs, lastFrameMs: input.frames.at(-1)!.timeMs,
    medianFramePeriodMs: median(periods), tolerancesMs: input.tolerancesMs, runs };
}
