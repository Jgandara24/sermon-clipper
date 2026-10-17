import { expect, it } from "vitest";
import { applySlideBoundaryPolicy, type slideBoundaryInputSchema } from "@/lib/media-regions/boundary-policy";
import type { z } from "zod";
import type { MediaRegionFact } from "@/lib/media-regions/types";
const sourceVideoId = "11111111-1111-4111-8111-111111111111", sourceSha256 = "a".repeat(64);
const fact = (startMs: number, endMs: number, kind: MediaRegionFact["kind"] = "FULLSCREEN_SLIDE"): MediaRegionFact => ({
  sourceVideoId, sourceSha256, sourceInterval: { startMs, endMs }, kind, detectorVersion: "fixture",
  configurationSha256: "b".repeat(64), evidenceSha256: "c".repeat(64), inputSha256: "d".repeat(64), confidence: 0.1,
  slideSubtype: kind === "FULLSCREEN_SLIDE" ? "SCRIPTURE" : null, ocrEvidence: null,
});
const input = (facts: MediaRegionFact[] = []): z.infer<typeof slideBoundaryInputSchema> => ({
  sourceVideoId, sourceSha256, candidate: { startMs: 1000, endMs: 11000 }, requiredSpeech: [{ startMs: 3000, endMs: 9000 }],
  safeStartsMs: [1000, 2000, 3000], safeEndsMs: [9000, 10000, 11000], facts,
  settings: { maxEdgeTrimMs: 2000, slideClearanceMs: 100, minimumClipMs: 5000 },
});
it("moves both edges to supplied safe points without cutting required speech", () => {
  expect(applySlideBoundaryPolicy(input([fact(0, 1800), fact(10200, 12000)]))).toMatchObject({ decision: "TRIMMED",
    sourceInterval: { startMs: 2000, endMs: 10000 }, evidence: { semanticApproval: "not_evaluated" } });
});
it("merges adjacent edge slides before choosing a safe point", () => {
  expect(applySlideBoundaryPolicy(input([fact(1000, 1500), fact(1500, 2500)]))).toMatchObject({ decision: "TRIMMED",
    sourceInterval: { startMs: 3000, endMs: 11000 } });
});
it("rejects middle slides and required speech removal", () => {
  expect(applySlideBoundaryPolicy(input([fact(5000, 6000)])).reason).toBe("MIDDLE_SLIDE");
  const request = input([fact(1000, 1800)]); request.requiredSpeech = [{ startMs: 1500, endMs: 9000 }];
  expect(applySlideBoundaryPolicy(request).reason).toBe("REQUIRED_SPEECH_REMOVED");
});
it.each(["WORSHIP", "ANNOUNCEMENT", "PRAYER", "BAPTISM", "ALTAR_CALL", "OTHER_SERVICE_CONTENT", "VERSE_SLIDESHOW"] as const)(
  "never salvages forbidden %s as an edge slide", kind => {
    expect(applySlideBoundaryPolicy(input([fact(1000, 1100, kind)]))).toMatchObject({ decision: "REJECT", reason: "FORBIDDEN_SERVICE_CONTENT" });
  });
it("rejects ambiguity regardless of confidence", () => {
  expect(applySlideBoundaryPolicy(input([fact(2000, 2500, "AMBIGUOUS")])).reason).toBe("AMBIGUOUS_REGION");
});
it("uses half-open overlap and makes no semantic approval claim", () => {
  expect(applySlideBoundaryPolicy(input([fact(0, 1000), fact(11000, 12000)]))).toMatchObject({ decision: "UNCHANGED",
    evidence: { semanticApproval: "not_evaluated" } });
});
it("rejects excessive trimming, absent safe cuts, and insufficient remaining duration", () => {
  const request = input([fact(1000, 2500)]); request.settings.maxEdgeTrimMs = 1000;
  expect(applySlideBoundaryPolicy(request).reason).toBe("EDGE_TRIM_LIMIT_EXCEEDED");
  request.safeStartsMs = [1000]; expect(applySlideBoundaryPolicy(request).reason).toBe("NO_SAFE_START");
  const short = input(); short.settings.minimumClipMs = 12000;
  expect(applySlideBoundaryPolicy(short).reason).toBe("CLIP_TOO_SHORT");
});
it("binds all inputs and settings without depending on fact order", () => {
  const a = fact(0, 1800), b = fact(10200, 12000);
  expect(applySlideBoundaryPolicy(input([a, b])).evidence.inputSha256).toBe(applySlideBoundaryPolicy(input([b, a])).evidence.inputSha256);
  const request = input([a]); request.settings.slideClearanceMs++;
  expect(applySlideBoundaryPolicy(request).evidence.inputSha256).not.toBe(applySlideBoundaryPolicy(input([a])).evidence.inputSha256);
  a.sourceSha256 = "e".repeat(64);
  expect(() => applySlideBoundaryPolicy(input([a]))).toThrow("SOURCE_MISMATCH");
});

it("never trims across an interior slide to reach a later safe start", () => {
  const request = input([fact(1000, 1800), fact(2100, 2200)]);
  request.safeStartsMs = [1000, 3000];
  expect(applySlideBoundaryPolicy(request).reason).toBe("MIDDLE_SLIDE");
});
it.each(["SCRIPTURE", "SERMON_TITLE", "MAIN_POINT", "SUBPOINT", "NUMBERED_POINT", "SECTION_TRANSITION", "OTHER_PRESENTATION"] as const)(
  "applies slide handling to subtype %s", subtype => {
    const slide = fact(1000, 1800); slide.slideSubtype = subtype;
    expect(applySlideBoundaryPolicy(input([slide])).decision).toBe("TRIMMED");
  });
it("rejects entire-candidate slides and duplicate fact identities", () => {
  expect(applySlideBoundaryPolicy(input([fact(0, 12000)])).reason).toBe("SLIDE_COVERS_CANDIDATE");
  const slide = fact(1000, 1800);
  expect(() => applySlideBoundaryPolicy(input([slide, slide]))).toThrow("DUPLICATE_FACT");
});
