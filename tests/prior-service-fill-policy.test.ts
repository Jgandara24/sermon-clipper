import { GeneratedClipStatus, ProjectStatus, SchedulePublishStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import * as policyModule from "@/lib/review/prior-service-fill-policy";
import {
  assessPriorServiceFill,
  describePriorServiceFillRefusal,
  type PriorServiceFillFacts,
  type PriorServiceFillRefusal,
} from "@/lib/review/prior-service-fill-policy";

/**
 * The truth table for "may this exact clip fill this exact empty date?".
 *
 * Every case starts from a pairing that is eligible in every respect and breaks exactly one thing,
 * so a passing case proves that fact is load-bearing rather than that the shape happens to be
 * wrong somewhere.
 */

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TARGET_SERVICE = "22222222-2222-4222-8222-222222222222";
const OLDER_SERVICE = "33333333-3333-4333-8333-333333333333";
const CANDIDATE = "44444444-4444-4444-8444-444444444444";

const NOW = new Date("2026-09-06T12:00:00.000Z");

function facts(): PriorServiceFillFacts {
  return {
    slot: {
      workspaceId: WORKSPACE,
      projectId: TARGET_SERVICE,
      publishStatus: SchedulePublishStatus.UNFILLED,
      scheduledDate: new Date("2026-09-13T00:00:00.000Z"),
      hasOpenPublishClaim: false,
    },
    targetService: { id: TARGET_SERVICE, serviceAt: new Date("2026-09-06T00:00:00.000Z") },
    candidateService: {
      id: OLDER_SERVICE,
      workspaceId: WORKSPACE,
      status: ProjectStatus.READY,
      serviceAt: new Date("2026-08-30T00:00:00.000Z"),
      renderableSource: true,
    },
    candidate: {
      id: CANDIDATE,
      status: GeneratedClipStatus.SUGGESTED,
      supersededAt: null,
      startMs: 600_000,
      endMs: 645_000,
      hasEverBeenScheduled: false,
      hasForbiddenFinding: false,
    },
    now: NOW,
  };
}

function expectRefusal(input: PriorServiceFillFacts, reason: PriorServiceFillRefusal) {
  expect(assessPriorServiceFill(input)).toEqual({ eligible: false, reason });
}

describe("the operator chooses, and nothing else does", () => {
  /**
   * The absence is the policy. Rev2 §9 puts automatic cross-project reserve borrowing out of
   * scope, and a module that could rank or search candidates is one call away from doing it. This
   * asserts the module offers no way to find a candidate — only a way to judge one already named.
   */
  it("exports no function that could pick a candidate", () => {
    expect(Object.keys(policyModule).sort()).toEqual([
      "assessPriorServiceFill",
      "describePriorServiceFillRefusal",
    ]);
  });

  it("permits an exact pairing where every fact holds", () => {
    expect(assessPriorServiceFill(facts())).toEqual({ eligible: true });
  });
});

describe("whose sermon it is", () => {
  it("refuses a clip from another church", () => {
    const input = facts();
    input.candidateService = { ...input.candidateService!, workspaceId: "other-workspace" };
    expectRefusal(input, "candidate_workspace_mismatch");
  });

  /** Not a fill at all: a clip of the same sermon is an ordinary reserve, and P2.7 promotes it. */
  it("refuses a clip from the same service", () => {
    const input = facts();
    input.candidateService = { ...input.candidateService!, id: TARGET_SERVICE };
    expectRefusal(input, "candidate_is_same_service");
  });

  it.each([
    ["the same day", "2026-09-06T00:00:00.000Z"],
    ["a later day", "2026-09-13T00:00:00.000Z"],
  ])("refuses a service preached on %s", (_label, serviceAt) => {
    const input = facts();
    input.candidateService = { ...input.candidateService!, serviceAt: new Date(serviceAt) };
    expectRefusal(input, "candidate_service_not_older");
  });

  it.each([
    ProjectStatus.DRAFT,
    ProjectStatus.QUEUED,
    ProjectStatus.PROCESSING,
    ProjectStatus.FAILED,
    ProjectStatus.CANCELED,
  ])("refuses a service in %s", (status) => {
    const input = facts();
    input.candidateService = { ...input.candidateService!, status };
    expectRefusal(input, "candidate_service_not_ready");
  });

  it("refuses a date with no service behind it", () => {
    const input = facts();
    input.slot = { ...input.slot, projectId: null };
    expectRefusal(input, "target_service_unknown");
  });

  it("reports the missing service ahead of everything else", () => {
    const input = facts();
    input.targetService = null;
    input.candidateService = null;
    input.candidate = { ...input.candidate, status: GeneratedClipStatus.HIDDEN };
    expectRefusal(input, "target_service_unknown");
  });
});

describe("what the candidate is", () => {
  /**
   * "Ever" is not rhetorical. A published slot keeps its `clipId` so the record of a real post
   * survives, so this catches a clip that already went out as well as one booked for a future
   * date. Borrowing either posts the same moment to a church twice.
   */
  it("refuses a clip that has ever had a date, including one already published", () => {
    const input = facts();
    input.candidate = { ...input.candidate, hasEverBeenScheduled: true };
    expectRefusal(input, "candidate_already_scheduled");
  });

  it.each([
    ["the timestamp alone", { supersededAt: new Date("2026-09-01T00:00:00.000Z") }],
    ["the status alone", { status: GeneratedClipStatus.SUPERSEDED }],
  ])("refuses a clip replaced out of its own service, on %s", (_label, moved) => {
    const input = facts();
    input.candidate = { ...input.candidate, ...moved };
    expectRefusal(input, "candidate_superseded");
  });

  it("refuses a clip somebody put away", () => {
    const input = facts();
    input.candidate = { ...input.candidate, status: GeneratedClipStatus.HIDDEN };
    expectRefusal(input, "candidate_hidden");
  });

  /**
   * The one irreversible verdict in the editorial standard. Separate from `HIDDEN`, which is only
   * a preference: a clip carrying something that must not reach an audience does not become
   * acceptable by being needed.
   */
  it("refuses a clip a reviewer marked as carrying forbidden content", () => {
    const input = facts();
    input.candidate = { ...input.candidate, hasForbiddenFinding: true };
    expectRefusal(input, "candidate_forbidden");
  });

  it("refuses a clip with no length to render", () => {
    const input = facts();
    input.candidate = { ...input.candidate, endMs: input.candidate.startMs };
    expectRefusal(input, "candidate_not_renderable_range");
  });

  it.each([GeneratedClipStatus.SUGGESTED, GeneratedClipStatus.KEPT])(
    "accepts a retained %s clip, because both are what a kept candidate holds",
    (status) => {
      const input = facts();
      input.candidate = { ...input.candidate, status };
      expect(assessPriorServiceFill(input)).toEqual({ eligible: true });
    },
  );
});

describe("whether it can still be made into a file", () => {
  it("accepts a service whose recording is still there", () => {
    expect(assessPriorServiceFill(facts())).toEqual({ eligible: true });
  });

  /**
   * Retention is not a remedy here, which is why this is a fact about what exists rather than
   * about an expiry date. Pushing an expiry out controls when media *will* be deleted; it cannot
   * bring back media that already is.
   */
  it("refuses a service whose recording has been purged", () => {
    const input = facts();
    input.candidateService = { ...input.candidateService!, renderableSource: false };
    expectRefusal(input, "source_not_renderable");
  });

  it("reports the clip's own state before the missing recording", () => {
    const input = facts();
    input.candidateService = { ...input.candidateService!, renderableSource: false };
    input.candidate = { ...input.candidate, status: GeneratedClipStatus.HIDDEN };
    // The operator can act on "that one is hidden" by picking another clip from the same sermon.
    expectRefusal(input, "candidate_hidden");
  });
});

describe("the date being filled", () => {
  it.each([SchedulePublishStatus.BLOCKED, SchedulePublishStatus.UNFILLED])(
    "accepts a %s date",
    (publishStatus) => {
      const input = facts();
      input.slot = { ...input.slot, publishStatus };
      expect(assessPriorServiceFill(input)).toEqual({ eligible: true });
    },
  );

  it.each([
    SchedulePublishStatus.NOT_STARTED,
    SchedulePublishStatus.IN_PROGRESS,
    SchedulePublishStatus.SUCCEEDED,
    SchedulePublishStatus.FAILED,
    SchedulePublishStatus.MISSED,
  ])("refuses a %s date", (publishStatus) => {
    const input = facts();
    input.slot = { ...input.slot, publishStatus };
    expectRefusal(input, "slot_state_not_fillable");
  });

  /**
   * P1.12 writes the publish intent *before* the provider call, so a process that died mid-publish
   * can leave a claim behind a state that looks safe. Filling that date would hand a second clip
   * to a post that may already exist.
   */
  it("refuses a date with an outstanding publish claim, whatever its state says", () => {
    const input = facts();
    input.slot = { ...input.slot, hasOpenPublishClaim: true };
    expectRefusal(input, "slot_publish_claimed");
  });

  it("refuses a date that has already passed", () => {
    const input = facts();
    input.slot = { ...input.slot, scheduledDate: new Date("2026-09-05T00:00:00.000Z") };
    expectRefusal(input, "slot_date_passed");
  });

  /** A date column, not an instant: today is still fillable at any hour of it. */
  it("accepts today, however late in the day the question is asked", () => {
    const input = facts();
    input.slot = { ...input.slot, scheduledDate: new Date("2026-09-06T00:00:00.000Z") };
    input.now = new Date("2026-09-06T23:59:59.000Z");
    expect(assessPriorServiceFill(input)).toEqual({ eligible: true });
  });
});

describe("describePriorServiceFillRefusal", () => {
  it("gives every reason its own sentence", () => {
    const reasons: PriorServiceFillRefusal[] = [
      "candidate_workspace_mismatch",
      "candidate_is_same_service",
      "candidate_service_not_older",
      "candidate_service_not_ready",
      "target_service_unknown",
      "candidate_already_scheduled",
      "candidate_superseded",
      "candidate_hidden",
      "candidate_forbidden",
      "candidate_not_renderable_range",
      "source_not_renderable",
      "slot_state_not_fillable",
      "slot_publish_claimed",
      "slot_date_passed",
    ];
    const messages = reasons.map(describePriorServiceFillRefusal);
    expect(new Set(messages).size).toBe(reasons.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(10);
  });
});
