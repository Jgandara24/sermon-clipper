"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePlatformOperator } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  readReschedule,
  type RescheduleActionState,
} from "@/lib/schedule/reschedule-input";
import {
  rescheduleMissedSlot,
  RescheduleMissedRefusedError,
} from "@/lib/schedule/reschedule-missed";

/**
 * Moving a missed post, from the operator's page.
 *
 * The only caller of `rescheduleMissedSlot`, and deliberately the only one there will be: `MISSED`
 * is terminal for automation, so no sweep or coordinator may reach it. An integration test asserts
 * that this file is the module's sole importer.
 *
 * Authorization is proved here rather than on the page that renders the form — a Server Action is
 * a POST endpoint anyone can reach.
 */

export async function submitRescheduleMissedAction(
  _previous: RescheduleActionState,
  formData: FormData,
): Promise<RescheduleActionState> {
  const operator = await requirePlatformOperator();

  try {
    const input = readReschedule(formData);

    const outcome = await rescheduleMissedSlot(prisma, {
      scheduledPostId: input.scheduledPostId,
      newDate: input.newDate,
      operatorUserId: operator.id,
    });

    revalidatePath("/app/operator/review");
    revalidatePath("/app/calendar");

    return {
      status: "success",
      message: `Moved to ${outcome.newDate.toISOString().slice(0, 10)}. The date is open again.`,
    };
  } catch (error) {
    if (error instanceof RescheduleMissedRefusedError) {
      return { status: "error", message: error.message };
    }
    if (error instanceof z.ZodError) {
      const confirmation = error.issues.find((issue) => issue.path[0] === "confirmed");
      return {
        status: "error",
        message: confirmation
          ? "Tick the confirmation before moving this date."
          : "Pick a date before moving this post.",
      };
    }
    console.error("[operator] reschedule failed", error);
    return {
      status: "error",
      message: "Something went wrong moving that date. Nothing was changed.",
    };
  }
}
