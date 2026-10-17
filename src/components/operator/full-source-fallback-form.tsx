"use client";

import { useActionState } from "react";
import { submitFullSourceFallbackAction } from "@/app/actions/operator-full-source-export";
import { FULL_SOURCE_FALLBACK_IDLE } from "@/lib/exports/full-source-fallback-input";

/**
 * Rendering one scheduled clip from the complete original because no approved range covers it.
 *
 * It asks for a reason and a confirmation, because it reads the whole service and costs more than a
 * range render. The server decides every refusal: a covered clip, a missing original, or a disabled switch.
 * Nothing here depends on hydration, so the form also submits before React has loaded.
 */
export function FullSourceFallbackForm({ clipId, clipTitle }: { clipId: string; clipTitle: string }) {
  const [state, action, pending] = useActionState(submitFullSourceFallbackAction, FULL_SOURCE_FALLBACK_IDLE);

  return (
    <form action={action} data-testid="full-source-fallback-form" className="grid gap-3">
      <input type="hidden" name="clipId" value={clipId} />
      <p className="text-sm font-medium text-stone-800">{clipTitle}</p>
      <label className="grid gap-1 text-xs">
        <span className="font-medium text-stone-700">Reason (kept with the review exception)</span>
        <textarea
          name="reason"
          maxLength={500}
          rows={2}
          data-testid="full-source-fallback-reason"
          className="rounded-md border border-stone-300 px-2 py-1 text-sm"
        />
      </label>
      <label className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs">
        <input type="checkbox" name="confirmed" className="mt-1" data-testid="full-source-fallback-confirm" />
        <span>
          Render this clip from the complete original. It is metered, and it opens a review exception that a
          person must resolve.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          data-testid="full-source-fallback-submit"
          className="rounded-md bg-teal-800 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          {pending ? "Queueing…" : "Request full-source export"}
        </button>
        {state.status !== "idle" ? (
          <p
            data-testid={`full-source-fallback-${state.status}`}
            className={state.status === "error" ? "text-xs text-rose-700" : "text-xs text-teal-800"}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
