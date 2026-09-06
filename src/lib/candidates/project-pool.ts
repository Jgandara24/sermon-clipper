import type {
  ClipReviewDecision,
  GeneratedClipStatus,
  ProcessingJobState,
  RenderQcStatus,
  SchedulePublishStatus,
} from "@prisma/client";

/**
 * What a service's candidate pool looks like, and who is allowed to see which parts of it.
 *
 * Pure. Every fact arrives as an argument, so the classification has a truth table of its own and
 * the query module is the only place that knows how to load anything.
 *
 * The pool is the retained set, and in this codebase that means `SUGGESTED` **and** `KEPT`.
 *
 * The enum reads as though `SUGGESTED` were "produced but not kept". It is not: `analyze.ts`
 * writes `SUGGESTED` for every candidate it retains, and nothing in production ever writes `KEPT`
 * — only a manual `PATCH /api/clips/[id]` can, and no surface calls it. So `SUGGESTED` is the
 * ordinary state of a clip in the pool, and excluding it empties every church's project page.
 * `HIDDEN` and `SUPERSEDED` are the two states a person or a replacement actually moves a clip
 * into, and those are the two the pool sets apart.
 */

export type CandidatePresentationState =
  /** A slot in this service holds it. */
  | "SCHEDULED"
  /** A slot in this service holds it because a `REPLACE` promoted it into that slot. */
  | "SELECTED_REPLACEMENT"
  /** A slot in this service holds a clip from an *older* service. Presentation only. */
  | "PRIOR_SERVICE_FILL"
  /** Kept, unused, and available. The queue is ordered by the selector's original rank. */
  | "RESERVE"
  /** Replaced out. Kept visible so a past decision stays legible. */
  | "SUPERSEDED"
  /** A person said "not this one". */
  | "HIDDEN";

/** The exact render a slot is bound to, as far as a pool view needs to know about it. */
export type BoundRenderFacts = {
  exportJobId: string;
  state: ProcessingJobState;
  qcStatus: RenderQcStatus | null;
};

export type PoolSlotFacts = {
  scheduledPostId: string;
  /** The service that owns the slot. Not necessarily the service the clip came from. */
  owningProjectId: string | null;
  scheduledDate: Date;
  publishStatus: SchedulePublishStatus;
  boundRender: BoundRenderFacts | null;
  latestDecision: ClipReviewDecision | null;
  /** Whether that decision was made about the file the slot holds now, or an earlier one. */
  decisionIsAboutBoundRender: boolean;
};

export type PoolClipFacts = {
  id: string;
  /** The service the clip was cut from. Differs from the pool's service for a borrowed fill. */
  projectId: string;
  /** The selector's ordering, preserved everywhere. Never renumbered by a replacement. */
  rank: number;
  status: GeneratedClipStatus;
  supersededAt: Date | null;
  title: string;
  hookText: string | null;
  startMs: number;
  endMs: number;
  /** The slot in this pool's service that holds the clip, if one does. */
  slot: PoolSlotFacts | null;
  /** True when a `REPLACE` promoted this clip into the slot it now holds. */
  promotedByReplacement: boolean;
};

/**
 * Which of the six states a candidate is in.
 *
 * The order is the whole rule, and one step of it is the reason this function exists.
 * **`PRIOR_SERVICE_FILL` is decided before the replacement check.** A clip borrowed from an older
 * service is very often promoted by a `REPLACE` — that is how it got into the slot — and calling
 * it `SELECTED_REPLACEMENT` would tell a church that this service produced a replacement it never
 * produced. The two states answer different questions: one is "how did it get here", the other is
 * "whose sermon is it".
 */
export function classifyCandidate(
  clip: PoolClipFacts,
  poolProjectId: string,
): CandidatePresentationState {
  if (clip.slot) {
    // Whose sermon it is, before how it got here.
    if (clip.projectId !== poolProjectId) return "PRIOR_SERVICE_FILL";
    if (clip.promotedByReplacement) return "SELECTED_REPLACEMENT";
    return "SCHEDULED";
  }

  // `supersededAt` and the status are written together by P2.7, but either alone is enough: a
  // clip that has been replaced out is not a reserve, whichever field says so.
  if (clip.supersededAt !== null || clip.status === "SUPERSEDED") return "SUPERSEDED";
  if (clip.status === "HIDDEN") return "HIDDEN";
  // Everything else — `SUGGESTED` as analysis writes it, `KEPT` as a person may set it — is a
  // clip this service produced that nothing has used yet.
  return "RESERVE";
}

export type PoolCandidate = {
  clipId: string;
  state: CandidatePresentationState;
  /** The selector's original rank, always. Reserve ordering reads from this and nothing else. */
  rank: number;
  title: string;
  hook: string | null;
  /** The source range this clip is cut from, and how long that is. */
  sourceRange: { startMs: number; endMs: number };
  durationMs: number;
  /** Present only for a candidate a slot holds. */
  scheduledDate: Date | null;
  publishStatus: SchedulePublishStatus | null;
  boundRender: BoundRenderFacts | null;
  review: {
    latestDecision: ClipReviewDecision | null;
    /** False when the decision on record was about a file this slot no longer holds. */
    isAboutBoundRender: boolean;
  };
  /**
   * Whether the media this clip would be rendered from still exists.
   *
   * A pool row whose source has been purged can be read but not acted on, and a church deciding
   * between reserves needs to know that before choosing one.
   */
  renderSourceAvailable: boolean;
  /** Null for a candidate of this service; the older service's id for a borrowed fill. */
  borrowedFromProjectId: string | null;
};

/**
 * One posting date this service owns, whether or not a clip is in it.
 *
 * The pool's candidate list is keyed by clip, so a slot holding nothing — what P2.7 leaves when a
 * replacement finds no reserve — has no row there at all. An operator inspecting a service has to
 * see the empty date; it is the one that needs acting on.
 */
export type PoolSlotSummary = {
  scheduledPostId: string;
  scheduledDate: Date;
  publishStatus: SchedulePublishStatus;
  /** Null for an `UNFILLED` slot: the date exists and nothing is in it. */
  clipId: string | null;
  boundRender: BoundRenderFacts | null;
};

/** Everything an operator may see about one service's pool. */
export type OperatorProjectPool = {
  projectId: string;
  projectName: string;
  /** How many candidates the pool actually holds — not the ceiling it was allowed. */
  retainedCount: number;
  candidates: PoolCandidate[];
  /** The reserve queue, in the selector's original rank order. */
  reserveQueue: PoolCandidate[];
  /** Every posting date this service owns, soonest first, empty ones included. */
  slots: PoolSlotSummary[];
  renderSourceAvailable: boolean;
  /**
   * Why this pool is the size it is. Operator-only, every one of them: a church that learned the
   * hard maximum would be reading a lever it cannot pull and did not agree to.
   */
  limits: {
    /** Frozen into the project when it was created. A later settings edit cannot move it. */
    effectiveSnapshot: number;
    masterDefault: number;
    hardMaximum: number;
    /** The per-church override, when one is set. Hidden from the church it applies to. */
    hiddenOverride: number | null;
  };
};

/**
 * What a church may see. Structurally the operator shape minus the operator-only parts.
 *
 * `slots` is omitted as well as `limits`, and for a different reason: an empty posting date is an
 * operational fact somebody has to act on, and P3.2 deliberately built the church view around
 * clips. Changing what a church is shown is a decision of its own, not a side effect of adding an
 * operator page.
 */
export type ChurchProjectPool = Omit<OperatorProjectPool, "limits" | "slots">;

export type BuildProjectPoolInput = {
  projectId: string;
  projectName: string;
  clips: PoolClipFacts[];
  slots: PoolSlotSummary[];
  renderSourceAvailable: boolean;
  limits: OperatorProjectPool["limits"];
};

export function buildProjectPool(input: BuildProjectPoolInput): OperatorProjectPool {
  const candidates = input.clips.map((clip): PoolCandidate => {
    const state = classifyCandidate(clip, input.projectId);
    return {
      clipId: clip.id,
      state,
      rank: clip.rank,
      title: clip.title,
      hook: clip.hookText,
      sourceRange: { startMs: clip.startMs, endMs: clip.endMs },
      durationMs: Math.max(0, clip.endMs - clip.startMs),
      scheduledDate: clip.slot?.scheduledDate ?? null,
      publishStatus: clip.slot?.publishStatus ?? null,
      boundRender: clip.slot?.boundRender ?? null,
      review: {
        latestDecision: clip.slot?.latestDecision ?? null,
        isAboutBoundRender: clip.slot?.decisionIsAboutBoundRender ?? false,
      },
      renderSourceAvailable: input.renderSourceAvailable,
      borrowedFromProjectId: clip.projectId === input.projectId ? null : clip.projectId,
    };
  });

  // Rank order throughout, so the list a church reads is the order the selector chose rather than
  // whatever the database returned. Ties break on the clip id for determinism; `@@unique
  // ([projectId, rank])` means a tie can only happen across a borrowed fill.
  const byRank = (a: PoolCandidate, b: PoolCandidate) =>
    a.rank !== b.rank ? a.rank - b.rank : a.clipId.localeCompare(b.clipId);
  candidates.sort(byRank);

  return {
    projectId: input.projectId,
    projectName: input.projectName,
    // The pool's actual size. A borrowed fill is presented here but belongs to another service's
    // pool, so it is not counted as one of this service's retained candidates.
    retainedCount: candidates.filter((c) => c.borrowedFromProjectId === null).length,
    candidates,
    reserveQueue: candidates.filter((c) => c.state === "RESERVE"),
    slots: [...input.slots].sort(
      (a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime(),
    ),
    renderSourceAvailable: input.renderSourceAvailable,
    limits: input.limits,
  };
}

/**
 * The church's view.
 *
 * Written as a removal from the operator shape rather than as a second literal, so a field added
 * to the pool later is visible to churches only if someone deletes it here on purpose. The
 * opposite arrangement — two independent literals — leaks by omission the first time anyone
 * forgets.
 */
export function toChurchPool(pool: OperatorProjectPool): ChurchProjectPool {
  const { limits: _limits, slots: _slots, ...church } = pool;
  return church;
}
