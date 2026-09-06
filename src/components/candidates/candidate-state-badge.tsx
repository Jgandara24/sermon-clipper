import type { CandidatePresentationState } from "@/lib/candidates/project-pool";

/**
 * What a church is told about each candidate's place in the service.
 *
 * The copy is the point. These six words are what a church member reads when they open a sermon,
 * so each one says what the state means for them — whether this clip is going out, whether it can
 * be — rather than naming the internal state that produced it.
 *
 * Nothing here mentions a limit. `docs/AGENTIC_EDITOR_IMPLEMENTATION_PLAN.md` §2.2: no
 * church-facing label exposes the configured ceiling or the hidden override, and a phrase like
 * "1 of 18" would do exactly that while looking like a helpful count.
 */

const PRESENTATION: Record<
  CandidatePresentationState,
  { label: string; description: string; className: string }
> = {
  SCHEDULED: {
    label: "Scheduled",
    description: "Booked for a posting date.",
    className: "border-teal-200 bg-teal-50 text-teal-900",
  },
  SELECTED_REPLACEMENT: {
    label: "Replacement",
    description: "Chosen after the first pick for this date was set aside.",
    className: "border-teal-200 bg-teal-50 text-teal-900",
  },
  PRIOR_SERVICE_FILL: {
    label: "From an earlier service",
    description: "This date is filled by a clip from a previous sermon.",
    className: "border-indigo-200 bg-indigo-50 text-indigo-900",
  },
  RESERVE: {
    label: "Reserve",
    description: "Available if a scheduled clip is set aside. Preview only — not yet rendered.",
    className: "border-stone-200 bg-stone-50 text-stone-700",
  },
  SUPERSEDED: {
    label: "Retired",
    description: "Set aside and replaced. Kept so the decision stays on the record.",
    className: "border-stone-200 bg-white text-stone-500",
  },
  HIDDEN: {
    label: "Hidden",
    description: "Put away, and not offered for a date.",
    className: "border-stone-200 bg-white text-stone-500",
  },
};

export function candidateStateCopy(state: CandidatePresentationState) {
  return PRESENTATION[state];
}

export function CandidateStateBadge({ state }: { state: CandidatePresentationState }) {
  const copy = PRESENTATION[state];
  return (
    <span
      data-testid={`candidate-state-${state}`}
      title={copy.description}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${copy.className}`}
    >
      {copy.label}
    </span>
  );
}
