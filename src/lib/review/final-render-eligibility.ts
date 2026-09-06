import { SchedulePublishStatus, type Prisma, type PrismaClient } from "@prisma/client";
import { automaticPublishingEnabled } from "@/lib/worker/reliability";

/**
 * Who may receive a final MP4.
 *
 * Rendering is the expensive step, and a rendered file that never publishes is money spent on
 * nothing. Under the agentic delivery regime every project produces more candidates than it has
 * posting slots, and the extras are reserves — real clips, ranked and kept, that no date is
 * waiting for. Rendering all of them would multiply the render bill by the size of the candidate
 * pool for no delivery. So a final render belongs to a clip a slot is actually waiting on.
 *
 * A reserve is not hidden by this. It keeps its source preview, its editor document, and its
 * place in the pool; what it does not get is a finished file nobody asked for. P2.7's atomic
 * replacement binds a promoted reserve to the slot *before* it enqueues that reserve's export, so
 * a promotion satisfies the same rule with no exception carved for it.
 */

export const FINAL_RENDER_REFUSED = "FINAL_RENDER_NOT_SCHEDULED";

export const FINAL_RENDER_REFUSED_MESSAGE =
  "This clip isn't scheduled to post, so it isn't rendered to a file. Schedule it, or replace a " +
  "scheduled clip with it, and the render happens automatically.";

/**
 * Slot states that can still receive a render.
 *
 * `SUCCEEDED` is done — the file that mattered already went out, and a fresh render would only
 * cost money and confuse which file was posted. `MISSED` is a date that passed. Everything else
 * is a slot still working toward a post: `NOT_STARTED` needs its first render, a `REVISE` leaves
 * the slot `NOT_STARTED` and needs another, `FAILED` may retry, and `BLOCKED` is an operator hold
 * that a person can lift.
 *
 * `UNFILLED` cannot appear here in practice — it means no clip is bound — but it is listed
 * because a slot that has just been refilled must be renderable before its status is rewritten.
 */
const RENDERABLE_SLOT_STATES: readonly SchedulePublishStatus[] = [
  SchedulePublishStatus.NOT_STARTED,
  SchedulePublishStatus.IN_PROGRESS,
  SchedulePublishStatus.FAILED,
  SchedulePublishStatus.BLOCKED,
  SchedulePublishStatus.UNFILLED,
];

export type FinalRenderVerdict =
  | { allowed: true; reason: "DELIVERY_REGIME_OFF" | "SCHEDULED" }
  | { allowed: false; reason: "UNSCHEDULED_RESERVE"; message: string };

export type FinalRenderEligibilityClient =
  | Pick<PrismaClient, "scheduledPost">
  | Prisma.TransactionClient;

/**
 * Whether this clip may be rendered to a final file.
 *
 * **The rule is off while automatic publishing is off, deliberately.** It exists to stop paying
 * for renders that will never publish, and while nothing publishes at all there is nothing for it
 * to save. More importantly, a church's manual export from the editor is a Tier 2 feature that
 * predates all of this: refusing it before the delivery regime is running would take away
 * something churches use today to prevent a cost that is not yet being incurred. Turning the
 * switch on turns this rule on with it — `docs/DEPLOYMENT.md` says so beside the switch, because
 * it is the one church-visible change hiding inside a delivery flag.
 */
export async function assessFinalRender(
  client: FinalRenderEligibilityClient,
  params: { clipId: string },
  options?: { publishingEnabled?: boolean },
): Promise<FinalRenderVerdict> {
  const enabled = options?.publishingEnabled ?? automaticPublishingEnabled();
  if (!enabled) {
    return { allowed: true, reason: "DELIVERY_REGIME_OFF" };
  }

  const boundSlots = await client.scheduledPost.count({
    where: { clipId: params.clipId, publishStatus: { in: [...RENDERABLE_SLOT_STATES] } },
  });

  return boundSlots > 0
    ? { allowed: true, reason: "SCHEDULED" }
    : { allowed: false, reason: "UNSCHEDULED_RESERVE", message: FINAL_RENDER_REFUSED_MESSAGE };
}

/** The states the coordinator will enqueue a first render for. Narrower than renderable. */
export const COORDINATOR_SLOT_STATE = SchedulePublishStatus.NOT_STARTED;

export { RENDERABLE_SLOT_STATES };
