import { expect, it } from "vitest";
import { deriveVerseSlideshows } from "@/lib/media-regions/slide-groups";
import { mediaRegionIdentityKey, type MediaRegionFact } from "@/lib/media-regions/types";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
const sourceVideoId = "11111111-1111-4111-8111-111111111111", sourceSha256 = "a".repeat(64);
function slide(startMs: number, endMs: number, subtype: MediaRegionFact["slideSubtype"] = "SCRIPTURE"): MediaRegionFact {
  return { sourceVideoId, sourceSha256, sourceInterval: { startMs, endMs }, kind: "FULLSCREEN_SLIDE",
    detectorVersion: "fixture-v1", configurationSha256: "b".repeat(64), inputSha256: "c".repeat(64),
    evidenceSha256: "d".repeat(64), confidence: 0.8, slideSubtype: subtype, ocrEvidence: "Synthetic text" };
}
it("groups adjacent scripture slides and binds their retained input identities", () => {
  const slides = [slide(0, 1000), { ...slide(1000, 2000), confidence: 0.2 }, slide(2000, 3000)];
  const result = deriveVerseSlideshows({ sourceVideoId, sourceSha256, maxGapMs: 0, slides });
  expect(result).toHaveLength(1);
  expect(result[0].fact).toMatchObject({ kind: "VERSE_SLIDESHOW", sourceInterval: { startMs: 0, endMs: 3000 },
    confidence: 0.2, slideSubtype: null, ocrEvidence: null });
  expect(result[0].evidence.parentIdentityKeys).toEqual(slides.map(mediaRegionIdentityKey));
  expect(result[0].fact.evidenceSha256).toBe(rangeEvidenceSha256(result[0].evidence));
  expect(deriveVerseSlideshows({ sourceVideoId, sourceSha256, maxGapMs: 0, slides: slides.toReversed() })).toEqual(result);
});
it("requires an explicit gap allowance and includes it in the evidence identity", () => {
  const input = { sourceVideoId, sourceSha256, maxGapMs: 99, slides: [slide(0, 1000), slide(1100, 2000)] };
  expect(deriveVerseSlideshows(input)).toEqual([]);
  const joined = deriveVerseSlideshows({ ...input, maxGapMs: 100 });
  expect(joined).toHaveLength(1);
  expect(joined[0].fact.configurationSha256).not.toBe(deriveVerseSlideshows({ ...input, maxGapMs: 101 })[0].fact.configurationSha256);
});
it("never groups a single scripture slide or crosses another slide subtype", () => {
  expect(deriveVerseSlideshows({ sourceVideoId, sourceSha256, maxGapMs: 10000,
    slides: [slide(0, 1000), slide(1000, 2000, "MAIN_POINT"), slide(2000, 3000)] })).toEqual([]);
  expect(deriveVerseSlideshows({ sourceVideoId, sourceSha256, maxGapMs: 0, slides: [slide(0, 1000)] })).toEqual([]);
});
it("keeps two separate consecutive sequences", () => {
  expect(deriveVerseSlideshows({ sourceVideoId, sourceSha256, maxGapMs: 0,
    slides: [slide(0, 1000), slide(1000, 2000), slide(3000, 4000), slide(4000, 5000)] })
    .map(group => group.fact.sourceInterval)).toEqual([{ startMs: 0, endMs: 2000 }, { startMs: 3000, endMs: 5000 }]);
});
it.each(["source", "checksum", "detector", "configuration", "overlap", "duplicate", "kind"])("rejects invalid input: %s", mode => {
  const second = slide(1000, 2000);
  if (mode === "source") second.sourceVideoId = "22222222-2222-4222-8222-222222222222";
  if (mode === "checksum") second.sourceSha256 = "e".repeat(64);
  if (mode === "detector") second.detectorVersion = "different";
  if (mode === "configuration") second.configurationSha256 = "e".repeat(64);
  if (mode === "overlap") second.sourceInterval.startMs = 999;
  if (mode === "duplicate") second.sourceInterval = { startMs: 0, endMs: 1000 };
  if (mode === "kind") { second.kind = "SERMON"; second.slideSubtype = null; }
  expect(() => deriveVerseSlideshows({ sourceVideoId, sourceSha256, maxGapMs: 0, slides: [slide(0, 1000), second] })).toThrow();
});
