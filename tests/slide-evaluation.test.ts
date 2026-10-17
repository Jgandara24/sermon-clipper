import { expect, it } from "vitest";
import { evaluateSlides, slideEvaluationSchema } from "@/lib/media-regions/slide-evaluation";
import type { z } from "zod";

function fixture(): z.infer<typeof slideEvaluationSchema> {
  const source = { sourceVideoId: "11111111-1111-4111-8111-111111111111", sourceSha256: "a".repeat(64) };
  return { datasetId: "synthetic-test-only", sources: [{ ...source, reviewReference: "test-labels-only",
    reviewedIntervals: [{ startMs: 0, endMs: 10000 }],
    slides: [{ sourceInterval: { startMs: 1000, endMs: 5000 }, subtype: "SCRIPTURE" }] }],
    runs: [{ detectorVersion: "fixture-v1", configurationSha256: "b".repeat(64), completedSources: [source],
      facts: [{ ...source, sourceInterval: { startMs: 2000, endMs: 6000 }, kind: "FULLSCREEN_SLIDE",
        detectorVersion: "fixture-v1", configurationSha256: "b".repeat(64), evidenceSha256: "c".repeat(64),
        inputSha256: "d".repeat(64), confidence: 0.1, slideSubtype: "SCRIPTURE", ocrEvidence: "Fixture" }] }] };
}
it("measures labeled milliseconds, including missed and false positive slide time", () => {
  const report = evaluateSlides(fixture());
  expect(report).toMatchObject({ productionApproval: "not_evaluated", sourceCount: 1 });
  expect(report.runs[0]).toMatchObject({ recallTargetMet: false, reviewedMs: 10000,
    allSlides: { labeledMs: 4000, predictedMs: 4000, matchedMs: 3000, missedMs: 1000,
      falsePositiveMs: 1000, recall: 0.75, precision: 0.75 } });
});
it("counts overlapping predictions and reviewed intervals once", () => {
  const input = fixture();
  input.runs[0].facts.push(input.runs[0].facts[0]);
  input.sources[0].reviewedIntervals.push({ startMs: 5000, endMs: 10000 });
  expect(evaluateSlides(input).runs[0].allSlides).toEqual(evaluateSlides(fixture()).runs[0].allSlides);
});
it("does not score predictions in unreviewed time as false positives", () => {
  const input = fixture();
  input.sources[0].reviewedIntervals = [{ startMs: 1000, endMs: 5000 }];
  input.runs[0].facts[0].sourceInterval = { startMs: 0, endMs: 10000 };
  expect(evaluateSlides(input).runs[0].allSlides).toMatchObject({ recall: 1, precision: 1, predictedMs: 4000 });
});
it("reports subtype errors even when the full-screen slide detection succeeds", () => {
  const input = fixture();
  input.runs[0].facts[0].sourceInterval = input.sources[0].slides[0].sourceInterval;
  input.runs[0].facts[0].slideSubtype = "MAIN_POINT";
  const run = evaluateSlides(input).runs[0];
  expect(run.allSlides.recall).toBe(1);
  expect(run.bySubtype.find(row => row.subtype === "SCRIPTURE")).toMatchObject({ recall: 0, precision: null });
  expect(run.bySubtype.find(row => row.subtype === "MAIN_POINT")).toMatchObject({ recall: null, precision: 0 });
});
it("uses duration weighting across services instead of averaging service percentages", () => {
  const input = fixture();
  const second = { ...input.sources[0], sourceVideoId: "22222222-2222-4222-8222-222222222222",
    slides: [{ sourceInterval: { startMs: 0, endMs: 1000 }, subtype: "SCRIPTURE" as const }] };
  input.sources.push(second);
  input.runs[0].completedSources.push({ sourceVideoId: second.sourceVideoId, sourceSha256: second.sourceSha256 });
  expect(evaluateSlides(input).runs[0].allSlides).toMatchObject({ labeledMs: 5000, matchedMs: 3000, recall: 0.6 });
});
it("keeps an empty positive denominator unknown and a completed empty detection at zero recall", () => {
  const input = fixture(); input.runs[0].facts = [];
  expect(evaluateSlides(input).runs[0].allSlides).toMatchObject({ recall: 0, precision: null });
  input.sources[0].slides = [];
  expect(evaluateSlides(input).runs[0]).toMatchObject({ recallTargetMet: null, allSlides: { recall: null, precision: null } });
});
it.each(["duplicate-source", "duplicate-run", "missing-run-source", "wrong-source-hash", "wrong-detector", "outside-review", "overlap"])(
  "rejects invalid evaluation evidence: %s", mode => {
    const input = fixture();
    if (mode === "duplicate-source") input.sources.push(input.sources[0]);
    if (mode === "duplicate-run") input.runs.push(input.runs[0]);
    if (mode === "missing-run-source") input.runs[0].completedSources = [];
    if (mode === "wrong-source-hash") input.runs[0].facts[0].sourceSha256 = "e".repeat(64);
    if (mode === "wrong-detector") input.runs[0].facts[0].detectorVersion = "different";
    if (mode === "outside-review") input.sources[0].slides[0].sourceInterval.endMs = 11000;
    if (mode === "overlap") input.sources[0].slides.push(input.sources[0].slides[0]);
    expect(() => evaluateSlides(input)).toThrow();
  });
it("binds reports to the supplied labels, review references, and exact detector inputs", () => {
  const input = fixture(); const original = evaluateSlides(input).inputSha256;
  input.sources[0].reviewReference = "different-review";
  expect(evaluateSlides(input).inputSha256).not.toBe(original);
});
