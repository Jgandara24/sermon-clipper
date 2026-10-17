import { z } from "zod";
import { sourceIntervalSchema } from "@/lib/media-artifacts/types";

const schema = z.object({ mediaInput: z.object({ kind: z.literal("ORIGINAL"), sourceVideoId: z.string().uuid(),
  sourceInterval: sourceIntervalSchema, editVersion: z.number().int().nonnegative() }) });

/** Historical exports without these facts need a new render, never an inferred interval. */
export function readOriginalRenderEvidence(qcDetails: unknown, editVersion: number | null) {
  const parsed = schema.safeParse(qcDetails);
  return parsed.success && parsed.data.mediaInput.editVersion === editVersion ? parsed.data.mediaInput : null;
}
