import { proxyViewPlanRequestSchema } from "./proxy-view-sampling";
import { z } from "zod";
import { analysisDerivativeSettingsSchema } from "./analysis-derivatives";
import { localEvidenceSettingsSchema } from "./local-evidence";
import { sermonAudioSettingsSchema, sermonCorridorSchema } from "./sermon-audio";
import { audioEvidenceSettingsSchema } from "./audio-evidence";
import { transcriptBoundarySettingsSchema } from "@/lib/transcription/boundaries";

/** No detector thresholds, retention dates, or corridor are inferred during activation. */
export const sermonPreparationConfigSchema = z.object({
  views: z.array(proxyViewPlanRequestSchema).max(8).optional(),
  version: z.literal("sermon-preparation-v1"),
  derivatives: analysisDerivativeSettingsSchema,
  localEvidence: localEvidenceSettingsSchema,
  sermon: z.object({ corridor: sermonCorridorSchema, settings: sermonAudioSettingsSchema }).strict(),
  structureAudio: audioEvidenceSettingsSchema,
  structureBoundaries: transcriptBoundarySettingsSchema,
  retention: z.object({ analysisExpiresAt: z.string().datetime().transform(value => new Date(value)),
    previewExpiresAt: z.string().datetime().transform(value => new Date(value)) }).strict(),
}).strict();

export function readSermonPreparationConfig(processingConfig: unknown) {
  return z.object({ sermonPreparation: sermonPreparationConfigSchema }).parse(processingConfig).sermonPreparation;
}
export function sermonPreparationEnabled(): boolean {
  return process.env.P4_SERMON_PREPARATION_ENABLED === "true";
}
