import { createHash } from "node:crypto";
import { z } from "zod";
import { sha256Schema, sourceIntervalSchema } from "@/lib/media-artifacts/types";

export const mediaRegionKindSchema = z.enum([
  "SERMON", "WORSHIP", "ANNOUNCEMENT", "PRAYER", "BAPTISM", "ALTAR_CALL",
  "OTHER_SERVICE_CONTENT", "PASTOR_VISIBLE", "FULLSCREEN_SLIDE", "VERSE_SLIDESHOW", "AMBIGUOUS",
]);

export const slideSubtypeSchema = z.enum([
  "SCRIPTURE", "SERMON_TITLE", "MAIN_POINT", "SUBPOINT", "NUMBERED_POINT",
  "SECTION_TRANSITION", "OTHER_PRESENTATION",
]);

/** Facts can overlap. This contract deliberately contains no editorial eligibility. */
export const mediaRegionSchema = z.object({
  sourceVideoId: z.string().uuid(),
  sourceSha256: sha256Schema,
  sourceInterval: sourceIntervalSchema,
  kind: mediaRegionKindSchema,
  detectorVersion: z.string().trim().min(1),
  configurationSha256: sha256Schema,
  evidenceSha256: sha256Schema,
  // Hash the exact detector input, including the transcript when it is used.
  inputSha256: sha256Schema,
  confidence: z.number().min(0).max(1),
  slideSubtype: slideSubtypeSchema.nullable(),
  ocrEvidence: z.string().nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.kind === "FULLSCREEN_SLIDE") !== (value.slideSubtype !== null)) {
    ctx.addIssue({ code: "custom", path: ["slideSubtype"],
      message: "Only full-screen slides must have a slide subtype." });
  }
});

export type MediaRegionFact = z.infer<typeof mediaRegionSchema>;

export function mediaRegionIdentityKey(input: MediaRegionFact): string {
  const value = mediaRegionSchema.parse(input);
  return createHash("sha256").update(JSON.stringify([
    "media-region-v1", value.sourceVideoId, value.sourceSha256, value.kind,
    value.detectorVersion, value.configurationSha256, value.inputSha256,
    value.sourceInterval.startMs, value.sourceInterval.endMs, value.slideSubtype,
  ])).digest("hex");
}
