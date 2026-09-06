import { z } from "zod";

/**
 * Reading a shortage-resolution submission, and the state its form carries.
 *
 * Separate from the Server Action for the reason P2.6 recorded and this slice re-learned: a
 * `"use server"` module may export nothing but async functions. A plain `const` in one is a build
 * error that arrives at *request* time — "can only export async functions, found object" — so
 * typecheck and lint both pass and the page breaks in a browser.
 *
 * The parsing is the part worth testing on its own anyway: it is the boundary where untrusted
 * `FormData` becomes something the fill command is allowed to see.
 */

export type PriorServiceFillActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const PRIOR_SERVICE_FILL_IDLE: PriorServiceFillActionState = {
  status: "idle",
  message: "",
};

/**
 * `confirmed` is a literal rather than a boolean.
 *
 * An unticked checkbox is absent from `FormData` entirely, so this fails as a missing field. That
 * is the intent: the confirmation has to be something a person did, not a field a POST could set
 * to `false` and still be read as present.
 */
export const priorServiceFillSchema = z.object({
  scheduledPostId: z.string().uuid(),
  /** Exactly one clip, named by the operator. There is no "pick for me". */
  candidateClipId: z.string().uuid(),
  confirmed: z.literal("on"),
});

export function readPriorServiceFill(formData: FormData) {
  return priorServiceFillSchema.parse({
    scheduledPostId: formData.get("scheduledPostId"),
    candidateClipId: formData.get("candidateClipId"),
    confirmed: formData.get("confirmed"),
  });
}
