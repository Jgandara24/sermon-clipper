import { ClipApprovalState, ProcessingJobState, RenderQcStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  assessDeliveryEligibility,
  describeDeliveryIneligibility,
  type DeliveryFacts,
  type DeliveryIneligibleReason,
} from "@/lib/delivery/eligibility";

/**
 * The truth table for "may this reach an audience?".
 *
 * Every case starts from a slot that is eligible in every respect and breaks exactly one thing,
 * so a passing case proves that one fact is load-bearing rather than that the whole shape happens
 * to be wrong.
 */

const CLIP_ID = "11111111-1111-4111-8111-111111111111";
const EXPORT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const CHECKSUM = "sha256:abc";

function eligibleFacts(): DeliveryFacts {
  return {
    globalPublishingEnabled: true,
    settings: { customerApprovalRequired: false, pilotHold: false },
    connection: { pageId: "page-1", autoPostEnabled: true },
    slot: {
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      clipId: CLIP_ID,
      exportJobId: EXPORT_ID,
      publishStatus: "NOT_STARTED",
    },
    clip: {
      id: CLIP_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      supersededAt: null,
      currentEditVersion: 3,
    },
    exportJob: {
      id: EXPORT_ID,
      workspaceId: WORKSPACE_ID,
      clipId: CLIP_ID,
      state: ProcessingJobState.SUCCEEDED,
      editVersion: 3,
      qcStatus: RenderQcStatus.PASSED,
      qcChecksum: CHECKSUM,
      outputFile: { checksum: CHECKSUM },
    },
    review: { decision: "ACCEPT" },
    approval: { state: ClipApprovalState.APPROVED },
  };
}

function expectReason(facts: DeliveryFacts, reason: DeliveryIneligibleReason) {
  expect(assessDeliveryEligibility(facts)).toEqual({ eligible: false, reason });
}

describe("assessDeliveryEligibility", () => {
  it("permits a slot where every fact holds", () => {
    expect(assessDeliveryEligibility(eligibleFacts())).toEqual({ eligible: true });
  });

  describe("program state", () => {
    it("refuses when the global switch is off", () => {
      expectReason(
        { ...eligibleFacts(), globalPublishingEnabled: false },
        "global_publishing_disabled",
      );
    });

    // The switch is the authority, not one vote among several: an installation with publishing
    // off must report that, whatever else is also wrong.
    it("reports the kill switch ahead of every other failure", () => {
      const facts = eligibleFacts();
      facts.globalPublishingEnabled = false;
      facts.settings.pilotHold = true;
      facts.connection = { pageId: null, autoPostEnabled: false };
      facts.clip = null;
      facts.exportJob = null;
      facts.review = null;
      expectReason(facts, "global_publishing_disabled");
    });

    it("refuses a workspace on an operator hold", () => {
      const facts = eligibleFacts();
      facts.settings.pilotHold = true;
      expectReason(facts, "pilot_hold");
    });

    it("refuses when no Page is connected", () => {
      const facts = eligibleFacts();
      facts.connection = { pageId: null, autoPostEnabled: true };
      expectReason(facts, "platform_not_connected");
    });

    it("refuses when a Page exists but auto-posting was never turned on", () => {
      const facts = eligibleFacts();
      facts.connection = { pageId: "page-1", autoPostEnabled: false };
      expectReason(facts, "platform_not_connected");
    });
  });

  describe("slot state", () => {
    it.each(["SUCCEEDED", "IN_PROGRESS"])("refuses a %s slot as already published", (status) => {
      const facts = eligibleFacts();
      facts.slot.publishStatus = status;
      expectReason(facts, "slot_already_published");
    });

    it.each(["BLOCKED", "UNFILLED", "MISSED"])("refuses a %s slot", (status) => {
      const facts = eligibleFacts();
      facts.slot.publishStatus = status;
      expectReason(facts, "slot_state_not_publishable");
    });

    it("permits a FAILED slot, which is a retry rather than a record of delivery", () => {
      const facts = eligibleFacts();
      facts.slot.publishStatus = "FAILED";
      expect(assessDeliveryEligibility(facts)).toEqual({ eligible: true });
    });
  });

  describe("the bound export, and never any other one", () => {
    // The defect this module exists to prevent: a slot with no binding must not cause anyone to
    // go looking for the clip's newest successful export.
    it("fails closed when the slot is bound to no export", () => {
      const facts = eligibleFacts();
      facts.slot.exportJobId = null;
      facts.exportJob = null;
      expectReason(facts, "slot_export_missing");
    });

    it("fails closed when the slot holds no clip", () => {
      const facts = eligibleFacts();
      facts.slot.clipId = null;
      facts.clip = null;
      expectReason(facts, "slot_clip_missing");
    });

    it("refuses when the loaded export is not the one the slot names", () => {
      const facts = eligibleFacts();
      facts.exportJob = { ...facts.exportJob!, id: "99999999-9999-4999-8999-999999999999" };
      expectReason(facts, "slot_export_identity_mismatch");
    });

    it("refuses when the export belongs to another clip", () => {
      const facts = eligibleFacts();
      facts.exportJob = { ...facts.exportJob!, clipId: "99999999-9999-4999-8999-999999999999" };
      expectReason(facts, "export_clip_mismatch");
    });

    it("refuses when the export belongs to another workspace", () => {
      const facts = eligibleFacts();
      facts.exportJob = { ...facts.exportJob!, workspaceId: "99999999-9999-4999-8999-999999999999" };
      expectReason(facts, "export_workspace_mismatch");
    });

    it.each([
      ProcessingJobState.QUEUED,
      ProcessingJobState.RUNNING,
      ProcessingJobState.FAILED,
    ])("refuses an export in state %s", (state) => {
      const facts = eligibleFacts();
      facts.exportJob = { ...facts.exportJob!, state };
      expectReason(facts, "export_not_succeeded");
    });
  });

  describe("the exact cut and the exact file", () => {
    it("refuses an export that does not record its edit version", () => {
      const facts = eligibleFacts();
      facts.exportJob = { ...facts.exportJob!, editVersion: null };
      expectReason(facts, "export_edit_version_missing");
    });

    it("refuses an export of an older cut than the clip now has", () => {
      const facts = eligibleFacts();
      facts.clip = { ...facts.clip!, currentEditVersion: 4 };
      expectReason(facts, "export_edit_version_stale");
    });

    it("refuses an export with no output file", () => {
      const facts = eligibleFacts();
      facts.exportJob = { ...facts.exportJob!, outputFile: null };
      expectReason(facts, "export_output_missing");
    });

    it("refuses an export with no QC checksum", () => {
      const facts = eligibleFacts();
      facts.exportJob = { ...facts.exportJob!, qcChecksum: null };
      expectReason(facts, "export_checksum_missing");
    });

    it("refuses when the file is not the one QC measured", () => {
      const facts = eligibleFacts();
      facts.exportJob = { ...facts.exportJob!, outputFile: { checksum: "sha256:different" } };
      expectReason(facts, "export_checksum_mismatch");
    });

    it("refuses an export that was never QC checked", () => {
      const facts = eligibleFacts();
      facts.exportJob = { ...facts.exportJob!, qcStatus: null };
      expectReason(facts, "render_qc_missing");
    });

    it("refuses an export that failed QC", () => {
      const facts = eligibleFacts();
      facts.exportJob = { ...facts.exportJob!, qcStatus: RenderQcStatus.FAILED };
      expectReason(facts, "render_qc_failed");
    });

    it("refuses a superseded clip", () => {
      const facts = eligibleFacts();
      facts.clip = { ...facts.clip!, supersededAt: new Date("2026-09-01T00:00:00.000Z") };
      expectReason(facts, "clip_superseded");
    });
  });

  describe("judgement", () => {
    // Intentional for all of P1: there is nowhere to record an editorial decision until P2, so
    // nothing is eligible. A change that makes this pass by default is a regression.
    it("refuses when no editorial review exists, which is every slot until P2", () => {
      const facts = eligibleFacts();
      facts.review = null;
      expectReason(facts, "editorial_review_missing");
    });

    it.each(["REVISE", "REPLACE"])("refuses an editorial %s", (decision) => {
      const facts = eligibleFacts();
      facts.review = { decision };
      expectReason(facts, "editorial_review_not_accepted");
    });

    it("ignores customer approval while the workspace does not require it", () => {
      const facts = eligibleFacts();
      facts.settings.customerApprovalRequired = false;
      facts.approval = null;
      expect(assessDeliveryEligibility(facts)).toEqual({ eligible: true });
    });

    it("requires customer approval once the workspace turns it on", () => {
      const facts = eligibleFacts();
      facts.settings.customerApprovalRequired = true;
      facts.approval = null;
      expectReason(facts, "customer_approval_missing");
    });

    it.each([
      ClipApprovalState.IN_REVIEW,
      ClipApprovalState.CHANGES_REQUESTED,
    ])("refuses approval state %s when approval is required", (state) => {
      const facts = eligibleFacts();
      facts.settings.customerApprovalRequired = true;
      facts.approval = { state };
      expectReason(facts, "customer_approval_missing");
    });

    /**
     * The case the plan names explicitly. A reviewer approved a cut, someone edited the clip, and
     * the approval was demoted — but the export from before the edit is still SUCCEEDED. Nothing
     * about that old export having worked may carry the new cut to an audience.
     */
    it("refuses after an edit demoted the approval, though an old SUCCEEDED export exists", () => {
      const facts = eligibleFacts();
      facts.settings.customerApprovalRequired = true;
      facts.clip = { ...facts.clip!, currentEditVersion: 4 };
      facts.approval = { state: ClipApprovalState.IN_REVIEW };
      // The stale cut is caught before approval is even consulted.
      expectReason(facts, "export_edit_version_stale");

      // And with the export re-rendered for the new cut, the demoted approval still refuses.
      facts.exportJob = { ...facts.exportJob!, editVersion: 4 };
      expectReason(facts, "customer_approval_missing");
    });
  });
});

describe("describeDeliveryIneligibility", () => {
  it("gives every reason its own sentence", () => {
    const reasons: DeliveryIneligibleReason[] = [
      "global_publishing_disabled",
      "pilot_hold",
      "platform_not_connected",
      "slot_already_published",
      "slot_state_not_publishable",
      "clip_superseded",
      "export_not_succeeded",
      "export_edit_version_missing",
      "export_edit_version_stale",
      "export_output_missing",
      "export_checksum_missing",
      "export_checksum_mismatch",
      "render_qc_missing",
      "render_qc_failed",
      "editorial_review_missing",
      "editorial_review_not_accepted",
      "customer_approval_missing",
      "slot_export_missing",
    ];
    const messages = reasons.map(describeDeliveryIneligibility);
    expect(new Set(messages).size).toBe(reasons.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(10);
  });
});
