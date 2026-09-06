import type { GeneratedClipStatus, ProjectStatus, SchedulePublishStatus } from "@prisma/client";

/**
 * Whether one exact candidate from an older service may fill one exact empty date.
 *
 * **There is no function here that chooses a candidate, and that absence is the policy.** The
 * shortage workflow is optional and manual: an operator looks at an empty date, picks a specific
 * clip from a specific earlier sermon, and this module says yes or no to that pairing. Rev2 §9
 * puts automatic cross-project reserve borrowing out of scope, and a module that could rank or
 * search candidates is one call away from doing it — so it cannot. `assessPriorServiceFill` takes
 * a candidate the operator named and nothing else.
 *
 * Pure, like the delivery rule and for the same reason: every fact arrives as an argument, so the
 * whole truth table is testable without a database and there is nowhere in here to look something
 * up that was not passed in.
 *
 * **Extending retention is not a substitute for any of this.** A caller facing a purged source
 * might reasonably think "push the expiry out and try again". Retention controls when media
 * *will* be deleted; it cannot bring back media that already is. `renderableSource` is therefore
 * a fact about what exists now, not about what is scheduled to expire.
 */

export type PriorServiceFillRefusal =
  // Whose sermon it is.
  | "candidate_workspace_mismatch"
  | "candidate_is_same_service"
  | "candidate_service_not_older"
  | "candidate_service_not_ready"
  | "target_service_unknown"
  // What the candidate is.
  | "candidate_already_scheduled"
  | "candidate_superseded"
  | "candidate_hidden"
  | "candidate_forbidden"
  | "candidate_not_renderable_range"
  // Whether it can still be made into a file.
  | "source_not_renderable"
  // The date being filled.
  | "slot_state_not_fillable"
  | "slot_publish_claimed"
  | "slot_date_passed";

export type PriorServiceFillAssessment =
  | { eligible: true }
  | { eligible: false; reason: PriorServiceFillRefusal };

/** The two slot states an empty date can be in. Everything else is history or in flight. */
const FILLABLE_SLOT_STATES = ["BLOCKED", "UNFILLED"] as const;

export type PriorServiceFillFacts = {
  /** The date being filled, and the service that owns it. */
  slot: {
    workspaceId: string;
    /** Null for a detached history row; without it there is no service to compare ages against. */
    projectId: string | null;
    publishStatus: SchedulePublishStatus;
    scheduledDate: Date;
    /**
     * Whether a publish attempt is outstanding against this slot.
     *
     * Checked separately from `publishStatus` on purpose. The state alone excludes a slot that is
     * publishing, but P1.12 writes an intent row *before* the provider call, so a process that
     * died mid-publish can leave a claim behind a state that looks safe. Filling that date would
     * be handing a second clip to a post that may already exist.
     */
    hasOpenPublishClaim: boolean;
  };
  /** The service that owns the empty date. */
  targetService: { id: string; serviceAt: Date } | null;
  /** The older service the candidate is being borrowed from. */
  candidateService: {
    id: string;
    workspaceId: string;
    status: ProjectStatus;
    /** The sermon's own date where it is known, otherwise when the project was created. */
    serviceAt: Date;
    /**
     * Whether the media this clip would be rendered from still exists.
     *
     * Before P4 that is a non-null `SourceVideo.storageKey`. After P4 it is a registered
     * renderable `DerivedMediaArtifact`. The distinction belongs to whatever loads these facts;
     * from here it is one boolean either way, which is what lets P4 move the source without
     * touching this rule.
     */
    renderableSource: boolean;
  } | null;
  candidate: {
    id: string;
    status: GeneratedClipStatus;
    supersededAt: Date | null;
    startMs: number;
    endMs: number;
    /**
     * Whether any scheduled-post row references this clip — now or ever.
     *
     * "Ever" is not rhetorical. A published slot keeps its `clipId` precisely so the record of a
     * real post survives, so this catches a clip that already went out as well as one booked for
     * a future date. Borrowing either would post the same moment to a church twice.
     */
    hasEverBeenScheduled: boolean;
    /**
     * Whether a reviewer recorded a `FORBIDDEN_CONTENT` finding against this clip.
     *
     * The editorial standard's one irreversible verdict: a clip carrying something that must not
     * reach an audience does not become acceptable by being needed. It is the reason this check
     * is separate from `HIDDEN`, which is only a preference.
     */
    hasForbiddenFinding: boolean;
  };
  /** The moment the assessment is made. A date that has passed cannot be filled. */
  now: Date;
};

/** Midnight-to-midnight comparison: `scheduledDate` is a date column, not an instant. */
function isBeforeDay(a: Date, b: Date): boolean {
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return day(a) < day(b);
}

/**
 * Whether this exact candidate may fill this exact date, and if not, the first reason it may not.
 *
 * The order is deliberate and the tests pin it. Whose sermon it is comes before what the clip is,
 * because "that clip belongs to another church" is a different conversation from "that clip is
 * hidden" — and an operator who picked the wrong workspace should be told that first.
 */
export function assessPriorServiceFill(
  facts: PriorServiceFillFacts,
): PriorServiceFillAssessment {
  const { slot, targetService, candidateService, candidate } = facts;

  // 1. Whose sermon it is. A detached slot has no service, so there is no age to compare against
  //    and no fill to authorise.
  if (!slot.projectId || !targetService) {
    return { eligible: false, reason: "target_service_unknown" };
  }
  if (!candidateService || candidateService.workspaceId !== slot.workspaceId) {
    return { eligible: false, reason: "candidate_workspace_mismatch" };
  }
  if (candidateService.id === targetService.id) {
    // Not a fill at all — a clip of the same sermon is an ordinary reserve, and P2.7 promotes it.
    return { eligible: false, reason: "candidate_is_same_service" };
  }
  if (!isBeforeDay(candidateService.serviceAt, targetService.serviceAt)) {
    // Strictly older. A sermon preached on the same day or later is not a *prior* service, and
    // borrowing forward would put next week's message out before it is preached.
    return { eligible: false, reason: "candidate_service_not_older" };
  }
  if (candidateService.status !== "READY") {
    return { eligible: false, reason: "candidate_service_not_ready" };
  }

  // 2. What the candidate is.
  if (candidate.hasEverBeenScheduled) {
    return { eligible: false, reason: "candidate_already_scheduled" };
  }
  if (candidate.supersededAt !== null || candidate.status === "SUPERSEDED") {
    return { eligible: false, reason: "candidate_superseded" };
  }
  if (candidate.status === "HIDDEN") return { eligible: false, reason: "candidate_hidden" };
  if (candidate.hasForbiddenFinding) {
    return { eligible: false, reason: "candidate_forbidden" };
  }
  if (candidate.endMs <= candidate.startMs) {
    return { eligible: false, reason: "candidate_not_renderable_range" };
  }

  // 3. Whether it can still be made into a file. Checked after the clip's own state so an
  //    operator is told "that one is hidden" rather than "that sermon is gone" when both are true
  //    — the first is something they can act on by picking another clip.
  if (!candidateService.renderableSource) {
    return { eligible: false, reason: "source_not_renderable" };
  }

  // 4. The date being filled.
  if (!FILLABLE_SLOT_STATES.some((state) => state === slot.publishStatus)) {
    return { eligible: false, reason: "slot_state_not_fillable" };
  }
  if (slot.hasOpenPublishClaim) {
    return { eligible: false, reason: "slot_publish_claimed" };
  }
  if (isBeforeDay(slot.scheduledDate, facts.now)) {
    return { eligible: false, reason: "slot_date_passed" };
  }

  return { eligible: true };
}

/** Operator-facing wording for a refusal. These go to a person choosing a clip, not to a log. */
export function describePriorServiceFillRefusal(reason: PriorServiceFillRefusal): string {
  switch (reason) {
    case "target_service_unknown":
      return "This date is not attached to a service, so there is nothing to fill it from.";
    case "candidate_workspace_mismatch":
      return "That clip belongs to a different church.";
    case "candidate_is_same_service":
      return "That clip is from this same sermon. Replacing within a sermon uses its reserves.";
    case "candidate_service_not_older":
      return "That sermon is not older than this one. Only an earlier service can fill a date.";
    case "candidate_service_not_ready":
      return "That sermon has not finished processing.";
    case "candidate_already_scheduled":
      return "That clip has already been given a date, now or in the past.";
    case "candidate_superseded":
      return "That clip was replaced out of its own service.";
    case "candidate_hidden":
      return "Somebody put that clip away.";
    case "candidate_forbidden":
      return "A reviewer marked that clip as carrying content that must not be published.";
    case "candidate_not_renderable_range":
      return "That clip has no length, so there is nothing to render.";
    case "source_not_renderable":
      return "The recording of that sermon has been deleted, so the clip can no longer be rendered.";
    case "slot_state_not_fillable":
      return "This date is not waiting to be filled.";
    case "slot_publish_claimed":
      return "A publish attempt is outstanding on this date. It may already have posted.";
    case "slot_date_passed":
      return "That date has already passed.";
    default:
      return `This clip cannot fill this date (${reason}).`;
  }
}
