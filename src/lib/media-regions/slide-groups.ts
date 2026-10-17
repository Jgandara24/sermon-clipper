import { z } from "zod";
import { sha256Schema } from "@/lib/media-artifacts/types";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { mediaRegionSchema, mediaRegionIdentityKey, type MediaRegionFact } from "./types";

export const VERSE_SLIDESHOW_VERSION = "consecutive-scripture-slides-v1";
export const slideGroupInputSchema = z.object({ sourceVideoId: z.string().uuid(), sourceSha256: sha256Schema,
  maxGapMs: z.number().int().nonnegative().safe(), slides: z.array(mediaRegionSchema).min(1).max(10000),
}).strict();

/** Input rows describe distinct slide intervals from one detector configuration. No OCR or semantic inference occurs here. */
export function deriveVerseSlideshows(value: z.infer<typeof slideGroupInputSchema>) {
  const input = slideGroupInputSchema.parse(value);
  const slides = [...input.slides].sort((a, b) => a.sourceInterval.startMs - b.sourceInterval.startMs);
  const first = slides[0];
  if (slides.some(slide => slide.kind !== "FULLSCREEN_SLIDE" || slide.sourceVideoId !== input.sourceVideoId ||
    slide.sourceSha256 !== input.sourceSha256 || slide.detectorVersion !== first.detectorVersion ||
    slide.configurationSha256 !== first.configurationSha256)) throw new Error("SLIDE_GROUP_INPUT_MISMATCH");
  for (let i = 1; i < slides.length; i++) {
    if (slides[i].sourceInterval.startMs < slides[i - 1].sourceInterval.endMs) throw new Error("SLIDE_GROUP_OVERLAPPING_INPUTS");
  }
  const sequences: MediaRegionFact[][] = [];
  let sequence: MediaRegionFact[] = [];
  const finish = () => { if (sequence.length > 1) sequences.push(sequence); sequence = []; };
  for (const slide of slides) {
    if (slide.slideSubtype !== "SCRIPTURE") { finish(); continue; }
    const previous = sequence.at(-1);
    if (previous && slide.sourceInterval.startMs - previous.sourceInterval.endMs > input.maxGapMs) finish();
    sequence.push(slide);
  }
  finish();
  return sequences.map(parents => {
    const sourceInterval = { startMs: parents[0].sourceInterval.startMs, endMs: parents.at(-1)!.sourceInterval.endMs };
    const configuration = { version: VERSE_SLIDESHOW_VERSION, maxGapMs: input.maxGapMs,
      inputDetectorVersion: first.detectorVersion, inputConfigurationSha256: first.configurationSha256 };
    const inputSha256 = rangeEvidenceSha256(parents);
    const evidence = { ...configuration, sourceVideoId: input.sourceVideoId, sourceSha256: input.sourceSha256,
      sourceInterval, inputSha256, parentIdentityKeys: parents.map(mediaRegionIdentityKey),
      confidenceAggregation: "minimum_input_confidence", detectorAccuracyVerified: false };
    const fact: MediaRegionFact = { sourceVideoId: input.sourceVideoId, sourceSha256: input.sourceSha256,
      sourceInterval, kind: "VERSE_SLIDESHOW", detectorVersion: VERSE_SLIDESHOW_VERSION,
      configurationSha256: rangeEvidenceSha256(configuration), inputSha256,
      evidenceSha256: rangeEvidenceSha256(evidence), confidence: Math.min(...parents.map(parent => parent.confidence)),
      slideSubtype: null, ocrEvidence: null };
    return { fact, evidence };
  });
}
