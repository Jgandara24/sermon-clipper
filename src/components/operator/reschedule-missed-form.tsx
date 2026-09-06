"use client";

import { useActionState } from "react";
import { submitRescheduleMissedAction } from "@/app/actions/operator-reschedule-missed";
import { RESCHEDULE_IDLE } from "@/lib/schedule/reschedule-input";

/**
 * Giving a missed post a new date.
 *
 * A missed date is terminal for automation: nothing sweeps it, nothing retries it, and the
 * allocator does not shift the rest of the week up to cover it. So this is the only way a missed
 * post moves, and it asks for two deliberate acts — a date, and a confirmation — for the same
 * reason the shortage form does. Moving a post changes what a church's followers see and when.
 *
 * The date input is a native `date`, which yields `YYYY-MM-DD` with no timezone attached. That is
 * exactly the shape the schema wants: it pins the value to UTC midnight, the form every stored
 * `scheduledDate` takes. Parsing it as a plain `Date` would apply the server's offset and could
 * land on the day before.
 *
 * **Nothing here is gated on client state.** The date field is uncontrolled, the confirmation is
 * always present, and the button is always enabled — so the form submits correctly before React
 * has hydrated, which is the behaviour a Server Action form is supposed to have. An earlier draft
 * revealed the field only after a date was chosen and disabled the button until then; that made
 * the whole control depend on hydration having finished, and it is the server that decides these
 * refusals anyway.
 */

export function RescheduleMissedForm({
  scheduledPostId,
  currentDate,
}: {
  scheduledPostId: string;
  /** The date that was missed, shown so an operator can see what they are moving. */
  currentDate: string;
}) {
  const [state, action, pending] = useActionState(submitRescheduleMissedAction, RESCHEDULE_IDLE);

  return (
    <form action={action} data-testid="reschedule-missed-form" className="grid gap-3">
      <input type="hidden" name="scheduledPostId" value={scheduledPostId} />

      <label className="grid gap-1 text-xs">
        <span className="font-medium text-stone-700">
          New date (this church&rsquo;s calendar, never a Sunday)
        </span>
        <input
          type="date"
          name="newDate"
          data-testid="reschedule-date"
          className="w-48 rounded-md border border-stone-300 px-2 py-1 text-sm"
        />
      </label>

      <label
        data-testid="reschedule-confirm"
        className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs"
      >
        <input type="checkbox" name="confirmed" className="mt-1" />
        <span>
          Move the post missed on {currentDate} to the date above. Later posts keep their own dates
          — nothing else in the week shifts.
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          data-testid="reschedule-submit"
          className="rounded-md bg-teal-800 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? "Moving…" : "Move this post"}
        </button>
        {/*
          In practice this renders refusals. A successful move stops the date being missed, so the
          row stops offering this form at all — the confirmation an operator sees is the date now
          sitting in the schedule where they put it.
        */}
        {state.status !== "idle" ? (
          <p
            data-testid={`reschedule-${state.status}`}
            className={state.status === "error" ? "text-xs text-rose-700" : "text-xs text-teal-800"}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
