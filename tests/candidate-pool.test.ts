import {
  ClipReviewDecision,
  GeneratedClipStatus,
  ProcessingJobState,
  RenderQcStatus,
  SchedulePublishStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  buildProjectPool,
  classifyCandidate,
  toChurchPool,
  type BuildProjectPoolInput,
  type PoolClipFacts,
  type PoolSlotFacts,
} from "@/lib/candidates/project-pool";

/**
 * Which of the six states a candidate is in, and what each role may read.
 *
 * Every case starts from a pool that classifies cleanly and moves exactly one fact, so a pass
 * proves that fact decides the state rather than that the shape happens to be right.
 */

const THIS_SERVICE = "project-this";
const OLDER_SERVICE = "project-older";

function slot(overrides: Partial<PoolSlotFacts> = {}): PoolSlotFacts {
  return {
    scheduledPostId: "slot-1",
    owningProjectId: THIS_SERVICE,
    scheduledDate: new Date("2026-09-13T00:00:00.000Z"),
    publishStatus: SchedulePublishStatus.NOT_STARTED,
    boundRender: {
      exportJobId: "export-1",
      state: ProcessingJobState.SUCCEEDED,
      qcStatus: RenderQcStatus.PASSED,
    },
    latestDecision: null,
    decisionIsAboutBoundRender: false,
    ...overrides,
  };
}

function clip(overrides: Partial<PoolClipFacts> = {}): PoolClipFacts {
  return {
    id: "clip-1",
    projectId: THIS_SERVICE,
    rank: 1,
    status: GeneratedClipStatus.KEPT,
    supersededAt: null,
    title: "The weight of mercy",
    hookText: "You have carried this long enough.",
    startMs: 600_000,
    endMs: 645_000,
    slot: null,
    promotedByReplacement: false,
    ...overrides,
  };
}

function poolInput(overrides: Partial<BuildProjectPoolInput> = {}): BuildProjectPoolInput {
  return {
    projectId: THIS_SERVICE,
    projectName: "Sunday 13 September",
    clips: [clip()],
    slots: [],
    renderSourceAvailable: true,
    limits: { effectiveSnapshot: 18, masterDefault: 18, hardMaximum: 24, hiddenOverride: null },
    ...overrides,
  };
}

describe("classifyCandidate", () => {
  it("calls an unused kept clip a reserve", () => {
    expect(classifyCandidate(clip(), THIS_SERVICE)).toBe("RESERVE");
  });

  it("calls a clip a slot holds scheduled", () => {
    expect(classifyCandidate(clip({ slot: slot() }), THIS_SERVICE)).toBe("SCHEDULED");
  });

  it("calls a promoted clip of this service a selected replacement", () => {
    expect(
      classifyCandidate(clip({ slot: slot(), promotedByReplacement: true }), THIS_SERVICE),
    ).toBe("SELECTED_REPLACEMENT");
  });

  /**
   * The mislabelling the plan names explicitly, and the reason the order of the checks is the
   * rule. A borrowed clip usually *was* promoted by a `REPLACE` — that is how it reached the slot
   * — so a classifier that asked "was it promoted?" first would tell a church this service
   * produced a replacement it never produced. The two states answer different questions: one is
   * how it got here, the other is whose sermon it is.
   */
  it("calls a borrowed clip a prior-service fill, even when a REPLACE promoted it", () => {
    const borrowed = clip({
      projectId: OLDER_SERVICE,
      slot: slot(),
      promotedByReplacement: true,
    });
    expect(classifyCandidate(borrowed, THIS_SERVICE)).toBe("PRIOR_SERVICE_FILL");
  });

  it("calls a borrowed clip a prior-service fill when nothing promoted it either", () => {
    const borrowed = clip({ projectId: OLDER_SERVICE, slot: slot() });
    expect(classifyCandidate(borrowed, THIS_SERVICE)).toBe("PRIOR_SERVICE_FILL");
  });

  it.each([
    ["the timestamp alone", { supersededAt: new Date("2026-09-06T00:00:00.000Z") }],
    ["the status alone", { status: GeneratedClipStatus.SUPERSEDED }],
    [
      "both together, as P2.7 writes them",
      {
        supersededAt: new Date("2026-09-06T00:00:00.000Z"),
        status: GeneratedClipStatus.SUPERSEDED,
      },
    ],
  ])("calls a replaced-out clip superseded on %s", (_label, moved) => {
    expect(classifyCandidate(clip(moved), THIS_SERVICE)).toBe("SUPERSEDED");
  });

  /**
   * The reading that emptied every church's project page until an end-to-end test caught it.
   *
   * `SUGGESTED` looks like "produced but not kept". It is not: `analyze.ts` writes it for every
   * candidate it retains, and nothing in production ever writes `KEPT`. A classifier that treats
   * `SUGGESTED` as rejected therefore rejects the entire pool.
   */
  it.each([GeneratedClipStatus.SUGGESTED, GeneratedClipStatus.KEPT])(
    "calls an unused %s clip a reserve, because both are what a retained clip holds",
    (status) => {
      expect(classifyCandidate(clip({ status }), THIS_SERVICE)).toBe("RESERVE");
    },
  );

  it("schedules a SUGGESTED clip like any other once a slot holds it", () => {
    expect(
      classifyCandidate(clip({ status: GeneratedClipStatus.SUGGESTED, slot: slot() }), THIS_SERVICE),
    ).toBe("SCHEDULED");
  });

  it("calls a clip somebody put away hidden", () => {
    expect(classifyCandidate(clip({ status: GeneratedClipStatus.HIDDEN }), THIS_SERVICE)).toBe(
      "HIDDEN",
    );
  });

  it("keeps a superseded or hidden clip out of the reserve queue", () => {
    const pool = buildProjectPool(
      poolInput({
        clips: [
          clip({ id: "a", rank: 1 }),
          clip({ id: "b", rank: 2, status: GeneratedClipStatus.HIDDEN }),
          clip({ id: "c", rank: 3, supersededAt: new Date() }),
        ],
      }),
    );
    expect(pool.reserveQueue.map((row) => row.clipId)).toEqual(["a"]);
  });
});

describe("the pool a service presents", () => {
  it("orders the reserve queue by the selector's original rank", () => {
    const pool = buildProjectPool(
      poolInput({
        clips: [
          clip({ id: "c", rank: 7 }),
          clip({ id: "a", rank: 2 }),
          clip({ id: "b", rank: 5 }),
        ],
      }),
    );
    expect(pool.reserveQueue.map((row) => row.rank)).toEqual([2, 5, 7]);
  });

  /**
   * Rank is the selector's ordering and nothing renumbers it. A replacement promotes rank 5 into
   * a slot; rank 5 is still rank 5, and the reserves behind it do not shuffle up.
   */
  it("preserves original rank through a replacement", () => {
    const pool = buildProjectPool(
      poolInput({
        clips: [
          clip({ id: "a", rank: 1, supersededAt: new Date() }),
          clip({ id: "b", rank: 5, slot: slot(), promotedByReplacement: true }),
          clip({ id: "c", rank: 6 }),
        ],
      }),
    );
    expect(pool.candidates.map((row) => [row.clipId, row.rank, row.state])).toEqual([
      ["a", 1, "SUPERSEDED"],
      ["b", 5, "SELECTED_REPLACEMENT"],
      ["c", 6, "RESERVE"],
    ]);
    expect(pool.reserveQueue.map((row) => row.rank)).toEqual([6]);
  });

  it("counts what the pool actually holds, not the ceiling it was allowed", () => {
    const pool = buildProjectPool(
      poolInput({
        clips: [clip({ id: "a", rank: 1 }), clip({ id: "b", rank: 2 })],
        limits: { effectiveSnapshot: 18, masterDefault: 18, hardMaximum: 24, hiddenOverride: null },
      }),
    );
    expect(pool.retainedCount).toBe(2);
    expect(pool.limits.effectiveSnapshot).toBe(18);
  });

  it("does not count a borrowed fill as one of this service's candidates", () => {
    const pool = buildProjectPool(
      poolInput({
        clips: [
          clip({ id: "a", rank: 1 }),
          clip({ id: "borrowed", rank: 2, projectId: OLDER_SERVICE, slot: slot() }),
        ],
      }),
    );
    expect(pool.retainedCount).toBe(1);
    expect(pool.candidates).toHaveLength(2);
    expect(pool.candidates.find((row) => row.clipId === "borrowed")).toMatchObject({
      state: "PRIOR_SERVICE_FILL",
      borrowedFromProjectId: OLDER_SERVICE,
    });
    expect(pool.candidates.find((row) => row.clipId === "a")?.borrowedFromProjectId).toBeNull();
  });

  it("carries the slot's date, render and review state onto a scheduled candidate", () => {
    const pool = buildProjectPool(
      poolInput({
        clips: [
          clip({
            slot: slot({
              latestDecision: ClipReviewDecision.ACCEPT,
              decisionIsAboutBoundRender: true,
            }),
          }),
        ],
      }),
    );
    expect(pool.candidates[0]).toMatchObject({
      state: "SCHEDULED",
      scheduledDate: new Date("2026-09-13T00:00:00.000Z"),
      publishStatus: SchedulePublishStatus.NOT_STARTED,
      boundRender: { exportJobId: "export-1", qcStatus: RenderQcStatus.PASSED },
      review: { latestDecision: ClipReviewDecision.ACCEPT, isAboutBoundRender: true },
    });
  });

  /**
   * The same four-fact question delivery asks (P2.8). A pool that reported "accepted" about a
   * file the slot no longer holds would repeat the defect one screen further out.
   */
  it("says an acceptance is not about the bound render when it is not", () => {
    const pool = buildProjectPool(
      poolInput({
        clips: [
          clip({
            slot: slot({
              latestDecision: ClipReviewDecision.ACCEPT,
              decisionIsAboutBoundRender: false,
            }),
          }),
        ],
      }),
    );
    expect(pool.candidates[0].review).toEqual({
      latestDecision: ClipReviewDecision.ACCEPT,
      isAboutBoundRender: false,
    });
  });

  it("leaves a reserve with no slot facts at all", () => {
    const pool = buildProjectPool(poolInput());
    expect(pool.candidates[0]).toMatchObject({
      state: "RESERVE",
      scheduledDate: null,
      publishStatus: null,
      boundRender: null,
      review: { latestDecision: null, isAboutBoundRender: false },
    });
  });

  it("reports the source range and its duration", () => {
    const pool = buildProjectPool(poolInput());
    expect(pool.candidates[0].sourceRange).toEqual({ startMs: 600_000, endMs: 645_000 });
    expect(pool.candidates[0].durationMs).toBe(45_000);
  });

  it("says so when the media a clip would be rendered from has been purged", () => {
    const pool = buildProjectPool(poolInput({ renderSourceAvailable: false }));
    expect(pool.renderSourceAvailable).toBe(false);
    expect(pool.candidates[0].renderSourceAvailable).toBe(false);
  });

  it("handles a thin pool, and an empty one", () => {
    expect(buildProjectPool(poolInput({ clips: [] }))).toMatchObject({
      retainedCount: 0,
      candidates: [],
      reserveQueue: [],
    });
    const thin = buildProjectPool(poolInput({ clips: [clip({ slot: slot() })] }));
    expect(thin.retainedCount).toBe(1);
    expect(thin.reserveQueue).toEqual([]);
  });
});

describe("what each role may read", () => {
  /**
   * A church that learned the hard maximum would be reading a lever it cannot pull and never
   * agreed to. The church shape is written as a removal from the operator shape, so a field added
   * later reaches churches only if someone deletes it here on purpose.
   */
  it("gives a church the pool without any internal limit", () => {
    const pool = buildProjectPool(poolInput());
    const church = toChurchPool(pool);

    expect("limits" in church).toBe(false);
    expect(JSON.stringify(church)).not.toContain("hardMaximum");
    expect(JSON.stringify(church)).not.toContain("hiddenOverride");
    expect(church.retainedCount).toBe(pool.retainedCount);
    expect(church.candidates).toEqual(pool.candidates);
  });

  /**
   * Not one of them appears in either shape. The plan lists them as facts a *church* must not
   * see, but S14 already says a reviewer must not see the machine's confidence in the work they
   * are judging, and no consumer needs them today — so the pool never carries one at all.
   */
  it("carries no selector signal in either shape", () => {
    const pool = buildProjectPool(
      poolInput({ clips: [clip({ slot: slot() }), clip({ id: "b", rank: 2 })] }),
    );
    for (const shape of [JSON.stringify(pool), JSON.stringify(toChurchPool(pool))]) {
      for (const forbidden of ["score", "subscores", "rationale", "excerpt", "modelVersion"]) {
        expect(shape).not.toContain(forbidden);
      }
    }
  });

  it("gives an operator the limits, including a hidden override when one is set", () => {
    const pool = buildProjectPool(
      poolInput({
        limits: { effectiveSnapshot: 12, masterDefault: 18, hardMaximum: 24, hiddenOverride: 12 },
      }),
    );
    expect(pool.limits).toEqual({
      effectiveSnapshot: 12,
      masterDefault: 18,
      hardMaximum: 24,
      hiddenOverride: 12,
    });
  });
});
