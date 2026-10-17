import { expect, it } from "vitest";
import { evaluateSceneChanges, type SceneChangeEvaluationInput } from "@/lib/media-regions/scene-change-evaluation";

function fixture(): SceneChangeEvaluationInput {
  // Synthetic 25 fps scores: strong changes at 1000 ms and 3040 ms, one weak change at 2000 ms.
  const frames = Array.from({ length: 200 }, (_, index) => ({ timeMs: index * 40, score: 0.5 }));
  for (const [timeMs, score] of [[1000, 40], [2000, 6], [3040, 25]] as const) frames[timeMs / 40].score = score;
  return { events: [
    { id: "exact", group: "cut", timeUs: 1000000 },
    { id: "late", group: "cut", timeUs: 3000500 },
    { id: "absent", group: "cut", timeUs: 6000000 },
    { id: "window", group: "window", windowUs: { startUs: 1500000, endUs: 2500000 } },
  ], frames, thresholds: [10, 5], tolerancesMs: [41, 250, 1000],
  reviewedWindowsUs: [{ id: "reviewed", startUs: 0, endUs: 4000000 }] };
}

it("reports signed errors, matches by tolerance, and misses", () => {
  const report = evaluateSceneChanges(fixture());
  expect(report.runs.map(run => run.threshold)).toEqual([5, 10]);
  const strict = report.runs[1];
  expect(strict.detections).toBe(2);
  expect(strict.events.slice(0, 3)).toMatchObject([
    { id: "exact", signedErrorMs: 0, missed: false, matchedWithinMs: { 41: true, 250: true, 1000: true } },
    { id: "late", signedErrorMs: 39.5, missed: false, matchedWithinMs: { 41: true } },
    { id: "absent", signedErrorMs: -2960, missed: true, matchedWithinMs: { 1000: false } },
  ]);
  expect(strict.groups[0]).toMatchObject({ group: "cut", pointEvents: 3, missed: 1, medianAbsoluteErrorMs: 39.5,
    maximumAbsoluteErrorMs: 2960, matchedWithinMs: { 41: 2, 250: 2, 1000: 2 } });
  expect(strict.events[3]).toMatchObject({ id: "window", detected: false });
  expect(report.runs[0].events[3]).toMatchObject({ detected: true, detectionsMs: [{ timeMs: 2000, score: 6 }] });
});

it("counts reviewed-window detections that no label explains without calling them false positives", () => {
  const report = evaluateSceneChanges(fixture());
  expect(report.runs[0].reviewedWindows).toEqual([{ id: "reviewed", detections: 3, unlabeledDetectionsMs: [] }]);
  const input = fixture();
  input.events = input.events.filter(event => event.id !== "late" && event.id !== "absent");
  input.tolerancesMs = [41];
  expect(evaluateSceneChanges(input).runs[0].reviewedWindows[0].unlabeledDetectionsMs).toEqual([2000, 3040]);
});

it("refuses unordered frames, duplicate events, and ambiguous events", () => {
  const unordered = fixture();
  unordered.frames[5].timeMs = 0;
  expect(() => evaluateSceneChanges(unordered)).toThrow("SCENE_EVALUATION_FRAMES_UNORDERED");
  const duplicate = fixture();
  duplicate.events.push({ ...duplicate.events[0] });
  expect(() => evaluateSceneChanges(duplicate)).toThrow("SCENE_EVALUATION_EVENT_DUPLICATE");
  const both = fixture();
  both.events[0] = { ...both.events[0], windowUs: { startUs: 0, endUs: 1 } };
  expect(() => evaluateSceneChanges(both)).toThrow();
  const empty = fixture();
  empty.events[3] = { id: "window", group: "window", windowUs: { startUs: 5, endUs: 5 } };
  expect(() => evaluateSceneChanges(empty)).toThrow();
});
