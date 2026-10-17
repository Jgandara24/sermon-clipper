import { z } from "zod";

export type FullSourceFallbackActionState =
  | { status: "idle" }
  | { status: "success" | "error"; message: string };

export const FULL_SOURCE_FALLBACK_IDLE: FullSourceFallbackActionState = { status: "idle" };

const formSchema = z.object({
  clipId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  // An unchecked box sends nothing, so a missing value is a refusal, not a default.
  confirmed: z.literal("on"),
});

export function readFullSourceFallbackForm(formData: FormData) {
  return formSchema.parse({ clipId: formData.get("clipId"), reason: formData.get("reason"), confirmed: formData.get("confirmed") });
}
