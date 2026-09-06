"use client";

import { useActionState, useState } from "react";
import { submitPriorServiceFillAction } from "@/app/actions/operator-prior-service-fill";
import { PRIOR_SERVICE_FILL_IDLE } from "@/lib/review/prior-service-fill-input";
import type { ShortageResolutionSlot } from "@/lib/review/prior-service-fill-options";

/**
 * Choosing one clip from an earlier sermon for a date that has nothing to post.
 *
 * **Nothing is preselected, and that is the requirement rather than an oversight.** A preselected
 * radio is a recommendation the product is not entitled to make: the whole reason cross-project
 * filling is manual is that borrowing one week's message for another week is an editorial
 * judgement. A default would turn "an operator decided" into "an operator did not object".
 *
 * The confirmation is a second, separate act for the same reason, and the action re-checks it —
 * a tick in a browser is a claim, and a POST that skipped this form would simply not send it.
 */

function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatRange(startMs: number, endMs: number) {
  const stamp = (ms: number) => {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
  };
  return `${stamp(startMs)}–${stamp(endMs)}`;
}

export function PriorServiceFillForm({ slot }: { slot: ShortageResolutionSlot }) {
  const [state, action, pending] = useActionState(
    submitPriorServiceFillAction,
    PRIOR_SERVICE_FILL_IDLE,
  );
  // Held so the confirmation can name the clip. Starts null: nothing is chosen for the operator.
  const [chosenClipId, setChosenClipId] = useState<string | null>(null);

  const chosen = slot.services
    .flatMap((service) => service.candidates.map((candidate) => ({ service, candidate })))
    .find((row) => row.candidate.clipId === chosenClipId);

  if (slot.services.length === 0) {
    return (
      <p data-testid="fill-no-options" className="text-sm text-stone-600">
        No earlier service has a clip this date could take. Every candidate is already scheduled,
        set aside, or belongs to a sermon whose recording has been deleted.
      </p>
    );
  }

  return (
    <form action={action} data-testid="prior-service-fill-form" className="grid gap-4">
      <input type="hidden" name="scheduledPostId" value={slot.scheduledPostId} />

      <div className="grid gap-4">
        {slot.services.map((service) => (
          <fieldset key={service.projectId} className="rounded-md border border-stone-200 p-3">
            <legend className="px-1 text-xs font-medium uppercase tracking-wide text-stone-500">
              {service.projectName} · {formatDay(service.serviceAt)}
              {service.speaker ? ` · ${service.speaker}` : ""}
            </legend>
            <div className="grid gap-2">
              {service.candidates.map((candidate) => (
                <label
                  key={candidate.clipId}
                  className="flex cursor-pointer items-start gap-2 rounded-md p-2 text-sm hover:bg-stone-50"
                >
                  <input
                    type="radio"
                    name="candidateClipId"
                    value={candidate.clipId}
                    // No `defaultChecked` anywhere in this list, on purpose.
                    checked={chosenClipId === candidate.clipId}
                    onChange={() => setChosenClipId(candidate.clipId)}
                    className="mt-1"
                  />
                  <span>
                    <span className="font-medium">{candidate.title}</span>
                    <span className="ml-2 text-xs text-stone-500">
                      Rank {candidate.rank} ·{" "}
                      {formatRange(candidate.startMs, candidate.endMs)} ·{" "}
                      {Math.round(candidate.durationMs / 1000)}s
                    </span>
                    {candidate.hook ? (
                      <span className="block text-xs italic text-stone-500">
                        &quot;{candidate.hook}&quot;
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      {chosen ? (
        <label
          data-testid="fill-confirm"
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm"
        >
          <input type="checkbox" name="confirmed" className="mt-1" />
          <span>
            Post <span className="font-medium">{chosen.candidate.title}</span> from{" "}
            {chosen.service.projectName} on {formatDay(slot.scheduledDate)}. This church&rsquo;s
            feed will carry a moment from an earlier sermon.
          </span>
        </label>
      ) : (
        <p data-testid="fill-choose-first" className="text-sm text-stone-500">
          Choose a clip to continue.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || !chosen}
          data-testid="fill-submit"
          className="rounded-md bg-teal-800 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Filling…" : "Fill this date"}
        </button>
        {/*
          In practice this renders refusals. A successful fill stops the date being a shortage, so
          the server stops sending options and this whole form unmounts — the confirmation an
          operator actually sees is the date itself, which now reads "a render is in progress".
          Kept because the action's contract has a success state, and a caller that did not
          unmount would want to show it.
        */}
        {state.status !== "idle" ? (
          <p
            data-testid={`fill-${state.status}`}
            className={state.status === "error" ? "text-sm text-rose-700" : "text-sm text-teal-800"}
          >
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
