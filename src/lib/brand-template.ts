import { z } from "zod";
import { CAPTION_PRESETS } from "@/lib/editor/caption-presets";

export const lowerThirdSchema = z.object({
  headline: z.string().trim().max(80).optional().default(""),
  subhead: z.string().trim().max(120).optional().default(""),
  showSpeaker: z.boolean().optional().default(true),
});

export const brandTemplateInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  churchName: z.string().trim().min(2).max(100),
  speakerName: z.string().trim().max(80).optional().or(z.literal("")),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  captionPresetId: z.string().refine((id) => CAPTION_PRESETS.some((preset) => preset.id === id)),
  lowerThirdHeadline: z.string().trim().max(80).optional().or(z.literal("")),
  lowerThirdSubhead: z.string().trim().max(120).optional().or(z.literal("")),
  isDefault: z.boolean().optional(),
});

export type BrandTemplateInput = z.infer<typeof brandTemplateInputSchema>;
export type LowerThird = z.infer<typeof lowerThirdSchema>;

export function buildLowerThird(input: BrandTemplateInput): LowerThird {
  return lowerThirdSchema.parse({
    headline: input.lowerThirdHeadline || input.churchName,
    subhead: input.lowerThirdSubhead || input.speakerName || "",
    showSpeaker: true,
  });
}

export function parseLowerThird(value: unknown): LowerThird {
  return lowerThirdSchema.catch({ headline: "", subhead: "", showSpeaker: true }).parse(value);
}
