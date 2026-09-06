import { z } from "zod";

/**
 * Reading a reschedule submission.
 *
 * Separate from the Server Action because a `"use server"` module may export nothing but async
 * functions, and that failure arrives at request time — past typecheck, lint and build. P2.6 and
 * P3.7 both learned this the hard way.
 */

export type RescheduleActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const RESCHEDULE_IDLE: RescheduleActionState = { status: "idle", message: "" };

/**
 * The date arrives as `YYYY-MM-DD` from a native date input — the church's own calendar date, with
 * no timezone attached to it. It is pinned to UTC midnight here, which is the shape
 * `scheduledDate` is stored in and the shape every weekday check in this codebase expects.
 * Parsing it as a plain `Date` would apply the *server's* offset and could land on the day before.
 */
export const rescheduleSchema = z.object({
  scheduledPostId: z.string().uuid(),
  newDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.")
    .transform((value) => {
      const [year, month, day] = value.split("-").map(Number);
      return new Date(Date.UTC(year, month - 1, day));
    }),
  confirmed: z.literal("on"),
});

export function readReschedule(formData: FormData) {
  return rescheduleSchema.parse({
    scheduledPostId: formData.get("scheduledPostId"),
    newDate: formData.get("newDate"),
    confirmed: formData.get("confirmed"),
  });
}
