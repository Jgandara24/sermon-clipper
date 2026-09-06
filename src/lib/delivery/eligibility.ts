import { ClipApprovalState, ProcessingJobState, RenderQcStatus } from "@prisma/client";
import { isClipApprovedForPublish } from "@/lib/approval";
import {
  verifyBoundDeliveryIdentity,
  type DeliveryIdentityReason,
} from "@/lib/delivery/identity-contract";
import type { DeliverySettings } from "@/lib/delivery/settings";
import { isEligibleForAutoPost, type FacebookConnection } from "@/lib/facebook-connection";

/**
 * The one module that decides whether a scheduled slot may reach an audience.
 *
 * Rev2 §6: "Nothing publishes unless one module proves the exact export, edit version, checksum,
 * review, optional customer approval, slot state, and program state are all eligible. There is no
 * 'latest successful export' path. A slot is bound to one export job."
 *
 * Pure. Every fact arrives as an argument, so the whole truth table is testable without a
 * database, and `query.ts` is the only place that knows how to load them.
 *
 * Fail-closed throughout: an absent fact is a refusal, never a pass. That is why the shape asks
 * for `exportJob: … | null` rather than letting a caller resolve one — the defect this module
 * exists to prevent is a publisher reaching for the newest successful export of a clip when the
 * slot's own binding is missing, which would post a cut nobody reviewed.
 */

export type DeliveryIneligibleReason =
  | DeliveryIdentityReason
  // Program state, checked ahead of everything else.
  | "global_publishing_disabled"
  | "pilot_hold"
  | "platform_not_connected"
  // The slot and its clip.
  | "slot_state_not_publishable"
  | "slot_already_published"
  | "clip_superseded"
  // The exact export the slot is bound to.
  | "export_not_succeeded"
  | "export_edit_version_missing"
  | "export_edit_version_stale"
  | "export_output_missing"
  | "export_checksum_missing"
  | "export_checksum_mismatch"
  | "render_qc_missing"
  | "render_qc_failed"
  // Judgement.
  | "editorial_review_missing"
  | "editorial_review_identity_mismatch"
  | "editorial_review_not_accepted"
  | "editorial_review_not_human"
  | "customer_approval_missing";

export type DeliveryEligibility =
  | { eligible: true }
  | { eligible: false; reason: DeliveryIneligibleReason };

/** Slot states from which a post may still go out. Everything else is history or an exception. */
const PUBLISHABLE_SLOT_STATES = ["NOT_STARTED", "FAILED"] as const;

export type DeliveryFacts = {
  /** `AUTOMATIC_PUBLISHING_ENABLED`. Absorbs P0.16 as one input rather than a second gate. */
  globalPublishingEnabled: boolean;
  settings: DeliverySettings;
  connection: FacebookConnection;
  slot: {
    workspaceId: string;
    projectId: string | null;
    clipId: string | null;
    exportJobId: string | null;
    publishStatus: string;
  };
  clip: {
    id: string;
    workspaceId: string;
    projectId: string;
    supersededAt: Date | null;
    /** The clip's newest saved edit. The bound export must be of exactly this cut. */
    currentEditVersion: number;
  } | null;
  exportJob: {
    id: string;
    workspaceId: string;
    clipId: string;
    state: ProcessingJobState;
    editVersion: number | null;
    qcStatus: RenderQcStatus | null;
    qcChecksum: string | null;
    outputFile: { checksum: string } | null;
  } | null;
  /**
   * The decision that currently stands about **this exact rendered file**, or null when no
   * decision has ever been made about it.
   *
   * Not "the latest decision about this slot", and not "the latest ACCEPT": the newest row
   * matching all four identity facts, whatever it says. Both of the other readings publish
   * something nobody agreed to. The latest-for-slot reading refuses a current acceptance because
   * an older render was revised; the latest-ACCEPT reading publishes a render that was accepted
   * and then revised, by skipping over the revision to find the acceptance underneath it.
   *
   * The four facts are carried here, rather than trusted from the loader, so that this module
   * still owns the whole rule. `query.ts` already matches on them; this checks the answer.
   */
  review: {
    decision: string;
    reviewerKind: string;
    identity: {
      clipId: string;
      exportJobId: string;
      editVersion: number;
      checksum: string;
    };
  } | null;
  /** The church's approval, when the workspace requires one. */
  approval: { state: ClipApprovalState | string | null } | null;
};

/**
 * Whether this slot may publish, and if not, the first reason it may not.
 *
 * The order is deliberate and the tests pin it. Program state comes first so that a kill switch
 * or a hold is always the reported reason — an operator who has switched publishing off should
 * be told that, not handed a checksum complaint about a clip they were never going to post.
 */
export function assessDeliveryEligibility(facts: DeliveryFacts): DeliveryEligibility {
  // 1. Program state. The global switch dominates every other input.
  if (!facts.globalPublishingEnabled) {
    return { eligible: false, reason: "global_publishing_disabled" };
  }
  if (facts.settings.pilotHold) return { eligible: false, reason: "pilot_hold" };
  if (!isEligibleForAutoPost(facts.connection)) {
    return { eligible: false, reason: "platform_not_connected" };
  }

  // 2. The slot itself. A published or in-flight row is not a candidate, and neither is one an
  //    operator blocked or the allocator marked missed or unfilled.
  if (facts.slot.publishStatus === "SUCCEEDED" || facts.slot.publishStatus === "IN_PROGRESS") {
    return { eligible: false, reason: "slot_already_published" };
  }
  if (!PUBLISHABLE_SLOT_STATES.some((state) => state === facts.slot.publishStatus)) {
    return { eligible: false, reason: "slot_state_not_publishable" };
  }

  // 3. Identity. Fails closed on a null bound export, which is the "never resolve the latest
  //    export" rule expressed as a type: there is nowhere in this module to look one up.
  if (!facts.clip || !facts.exportJob) {
    return {
      eligible: false,
      reason: !facts.slot.clipId
        ? "slot_clip_missing"
        : !facts.slot.exportJobId
          ? "slot_export_missing"
          : !facts.clip
            ? "slot_clip_missing"
            : "slot_export_missing",
    };
  }
  const identity = verifyBoundDeliveryIdentity({
    slot: facts.slot,
    clip: facts.clip,
    exportJob: facts.exportJob,
  });
  if (!identity.ok) return { eligible: false, reason: identity.reason };

  // 4. The clip. A superseded clip is a cut that has been replaced; its export is of something
  //    the project no longer offers.
  if (facts.clip.supersededAt !== null) return { eligible: false, reason: "clip_superseded" };

  // 5. The exact export, and that it is of the cut that exists now. An export of an older edit
  //    version renders text and timings nobody reviewed, however successful the job was.
  const job = facts.exportJob;
  if (job.state !== ProcessingJobState.SUCCEEDED) {
    return { eligible: false, reason: "export_not_succeeded" };
  }
  if (job.editVersion === null) {
    return { eligible: false, reason: "export_edit_version_missing" };
  }
  if (job.editVersion !== facts.clip.currentEditVersion) {
    return { eligible: false, reason: "export_edit_version_stale" };
  }

  // 6. The file, and that it is the file QC measured. A checksum recorded against one render and
  //    a file that is now a different one is exactly the swap this proves against.
  if (!job.outputFile) return { eligible: false, reason: "export_output_missing" };
  if (!job.qcChecksum) return { eligible: false, reason: "export_checksum_missing" };
  if (job.qcChecksum !== job.outputFile.checksum) {
    return { eligible: false, reason: "export_checksum_mismatch" };
  }
  if (job.qcStatus === null) return { eligible: false, reason: "render_qc_missing" };
  if (job.qcStatus !== RenderQcStatus.PASSED) {
    return { eligible: false, reason: "render_qc_failed" };
  }

  // 7. Judgement. Editorial ACCEPT always; the church's approval only when the workspace asks
  //    for one (Decision D).
  if (!facts.review) return { eligible: false, reason: "editorial_review_missing" };

  // The four facts the decision was recorded against must still be the four facts the slot
  // holds. Each one on its own is an invalidator, and between them they cover every way a render
  // can change under a standing acceptance: a newer edit and a replacement move the clip or the
  // edit version, a fresh render moves the export id, and a rerender of the same job moves the
  // checksum while leaving the other three alone. That last one is why the export id is not
  // enough by itself — an id survives bytes changing underneath it, and an acceptance must not.
  const reviewed = facts.review.identity;
  if (
    reviewed.clipId !== facts.clip.id ||
    reviewed.exportJobId !== job.id ||
    reviewed.editVersion !== job.editVersion ||
    reviewed.checksum !== job.qcChecksum
  ) {
    return { eligible: false, reason: "editorial_review_identity_mismatch" };
  }

  if (facts.review.decision !== "ACCEPT") {
    return { eligible: false, reason: "editorial_review_not_accepted" };
  }

  // The human-reference phase means a person accepted it, not that an acceptance exists. Nothing
  // writes an AGENT row today, which is exactly why this is worth writing now: when P4 starts
  // producing agent reviews, they must not become publishable by having arrived. P7 is where
  // that is explicitly changed, after replay evidence, and not before.
  if (facts.review.reviewerKind !== "HUMAN") {
    return { eligible: false, reason: "editorial_review_not_human" };
  }
  if (facts.settings.customerApprovalRequired) {
    if (!isClipApprovedForPublish(facts.approval?.state ?? null)) {
      return { eligible: false, reason: "customer_approval_missing" };
    }
  }

  return { eligible: true };
}

/** Operator-facing wording for a refusal. Not church-facing copy; these go to logs and events. */
export function describeDeliveryIneligibility(reason: DeliveryIneligibleReason): string {
  switch (reason) {
    case "global_publishing_disabled":
      return "Automatic publishing is switched off for the whole installation.";
    case "pilot_hold":
      return "This workspace is on an operator hold.";
    case "platform_not_connected":
      return "The workspace has no connected Page, or auto-posting has not been turned on for it.";
    case "slot_already_published":
      return "This slot has already published or is publishing now.";
    case "slot_state_not_publishable":
      return "This slot is not in a state that can publish.";
    case "clip_superseded":
      return "The clip this slot holds has been superseded.";
    case "export_not_succeeded":
      return "The export this slot is bound to has not succeeded.";
    case "export_edit_version_missing":
      return "The bound export does not record which edit it rendered.";
    case "export_edit_version_stale":
      return "The bound export rendered an older cut than the clip now has.";
    case "export_output_missing":
      return "The bound export has no output file.";
    case "export_checksum_missing":
      return "The bound export has no QC checksum.";
    case "export_checksum_mismatch":
      return "The output file is not the file QC measured.";
    case "render_qc_missing":
      return "The bound export has never been QC checked.";
    case "render_qc_failed":
      return "The bound export failed render QC.";
    case "editorial_review_missing":
      return "No editorial review exists for this render.";
    case "editorial_review_identity_mismatch":
      return "The editorial decision on hand was made about a different file than this slot holds.";
    case "editorial_review_not_accepted":
      return "The editorial review did not accept this render.";
    case "editorial_review_not_human":
      return "This render was accepted by an agent, and delivery requires a person's acceptance.";
    case "customer_approval_missing":
      return "This workspace requires the church to approve a clip, and this one is not approved.";
    default:
      return `The slot, clip and export do not refer to each other correctly (${reason}).`;
  }
}
