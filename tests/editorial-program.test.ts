import {
  ClipReviewDecision,
  EditorialCohort,
  EditorialProgramState,
  ReviewerKind,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  activeElapsedMs,
  missingEvidence,
  summariseEditorialProgram,
  type ProgramSummaryInput,
  type StartEvidence,
} from "@/lib/review/editorial-program";
import { HUMAN_REFERENCE_MINIMUM_DAYS } from "@/lib/review/program-key";

/**
 * The arithmetic the whole phase rests on.
 *
 * Two claims are load-bearing and neither needs a database to state: day 29 is held and day 30 is
 * not, and a pause moves the thirtieth day out rather than letting it arrive on time.
 */

const DAY = 86_400_000;
const START = new Date("2026-09-06T09:00:00.000Z");

function at(days: number, extraMs = 0): Date {
  return new Date(START.getTime() + days * DAY + extraMs);
}

function summaryInput(overrides: Partial<ProgramSummaryInput> = {}): ProgramSummaryInput {
  return {
    program: {
      key: "human-reference",
      state: EditorialProgramState.ACTIVE,
      startedAt: START,
      pausedAt: null,
      pausedMs: BigInt(0),
      minimumDays: HUMAN_REFERENCE_MINIMUM_DAYS,
    },
    startedByEmail: "operator@example.com",
    cohorts: [],
    reviews: [],
    now: at(1),
    ...overrides,
  };
}

describe("the fixed thirty days", () => {
  it("counts whole elapsed days, not calendar dates crossed", () => {
    // Started at 09:00. Midnight has passed but a day has not.
    expect(summariseEditorialProgram(summaryInput({ now: at(0, 20 * 3_600_000) })).elapsedDays).toBe(
      0,
    );
    expect(summariseEditorialProgram(summaryInput({ now: at(1) })).elapsedDays).toBe(1);
  });

  it("holds at day 29 and is served at day 30", () => {
    const held = summariseEditorialProgram(summaryInput({ now: at(29, -1) }));
    expect(held.elapsedDays).toBe(28);
    expect(held.minimumMet).toBe(false);

    const alsoHeld = summariseEditorialProgram(summaryInput({ now: at(29) }));
    expect(alsoHeld.elapsedDays).toBe(29);
    expect(alsoHeld.minimumMet).toBe(false);

    const served = summariseEditorialProgram(summaryInput({ now: at(30) }));
    expect(served.elapsedDays).toBe(30);
    expect(served.minimumMet).toBe(true);
  });

  /**
   * The end of the phase is when the next one may be *considered*. It is not the moment a person
   * stops being the authority — only P7, deployed and explicitly changed, moves that.
   */
  it("stays human-authoritative after the minimum is served", () => {
    const served = summariseEditorialProgram(summaryInput({ now: at(90) }));
    expect(served.minimumMet).toBe(true);
    expect(served.humanAuthoritative).toBe(true);
  });

  it("is not shortened by a large or unanimous decision set", () => {
    const reviews = Array.from({ length: 500 }, () => ({
      decision: ClipReviewDecision.ACCEPT,
      reviewerKind: ReviewerKind.HUMAN,
      createdAt: at(1),
      exportFinishedAt: at(0),
    }));
    const status = summariseEditorialProgram(summaryInput({ reviews, now: at(29) }));
    expect(status.decisions.accept).toBe(500);
    expect(status.minimumMet).toBe(false);
  });
});

describe("a pause extends the phase", () => {
  it("holds the clock while paused, without banking anything yet", () => {
    // Paused on day 10, still paused on day 20: ten days elapsed, not twenty.
    const paused = summariseEditorialProgram(
      summaryInput({
        program: {
          ...summaryInput().program,
          state: EditorialProgramState.PAUSED,
          pausedAt: at(10),
        },
        now: at(20),
      }),
    );
    expect(paused.elapsedDays).toBe(10);
  });

  it("moves the thirtieth day out by exactly the length of the pause", () => {
    const banked = { ...summaryInput().program, pausedMs: BigInt(7 * DAY) };

    // Day 30 by the wall clock, but a week of it was paused.
    const early = summariseEditorialProgram(summaryInput({ program: banked, now: at(30) }));
    expect(early.elapsedDays).toBe(23);
    expect(early.minimumMet).toBe(false);

    const served = summariseEditorialProgram(summaryInput({ program: banked, now: at(37) }));
    expect(served.elapsedDays).toBe(30);
    expect(served.minimumMet).toBe(true);
  });

  it("never reports negative elapsed time, however the clocks disagree", () => {
    expect(
      activeElapsedMs(
        { startedAt: START, pausedAt: null, pausedMs: BigInt(90 * DAY) },
        at(1),
      ),
    ).toBe(0);
  });

  it("reports nothing elapsed before the program starts", () => {
    expect(activeElapsedMs({ startedAt: null, pausedAt: null, pausedMs: BigInt(0) }, at(5))).toBe(0);
  });
});

describe("what the window records", () => {
  it("counts each decision under its own name", () => {
    const status = summariseEditorialProgram(
      summaryInput({
        reviews: [
          { decision: ClipReviewDecision.ACCEPT, reviewerKind: ReviewerKind.HUMAN, createdAt: at(1), exportFinishedAt: null },
          { decision: ClipReviewDecision.ACCEPT, reviewerKind: ReviewerKind.HUMAN, createdAt: at(1), exportFinishedAt: null },
          { decision: ClipReviewDecision.REVISE, reviewerKind: ReviewerKind.HUMAN, createdAt: at(2), exportFinishedAt: null },
          { decision: ClipReviewDecision.REPLACE, reviewerKind: ReviewerKind.HUMAN, createdAt: at(3), exportFinishedAt: null },
        ],
      }),
    );
    expect(status.decisions).toEqual({ accept: 2, revise: 1, replace: 1, total: 4 });
  });

  /**
   * A phase with machine decisions in it is not a reference set for judging machine decisions.
   * Counted separately and never folded into the human totals, so the contamination is visible
   * rather than averaged away.
   */
  it("counts agent rows apart, and keeps them out of the human totals", () => {
    const status = summariseEditorialProgram(
      summaryInput({
        reviews: [
          { decision: ClipReviewDecision.ACCEPT, reviewerKind: ReviewerKind.HUMAN, createdAt: at(1), exportFinishedAt: null },
          { decision: ClipReviewDecision.ACCEPT, reviewerKind: ReviewerKind.AGENT, createdAt: at(1), exportFinishedAt: null },
        ],
      }),
    );
    expect(status.agentReviews).toBe(1);
    expect(status.decisions).toEqual({ accept: 1, revise: 0, replace: 0, total: 1 });
  });

  it("reports a clean window as zero agent rows", () => {
    expect(summariseEditorialProgram(summaryInput()).agentReviews).toBe(0);
  });

  it("measures how long each render waited for a person", () => {
    const status = summariseEditorialProgram(
      summaryInput({
        reviews: [
          { decision: ClipReviewDecision.ACCEPT, reviewerKind: ReviewerKind.HUMAN, createdAt: at(1), exportFinishedAt: at(0) },
          { decision: ClipReviewDecision.REVISE, reviewerKind: ReviewerKind.HUMAN, createdAt: at(5), exportFinishedAt: at(2) },
          { decision: ClipReviewDecision.ACCEPT, reviewerKind: ReviewerKind.HUMAN, createdAt: at(9), exportFinishedAt: at(2) },
        ],
      }),
    );
    expect(status.reviewLatency).toEqual({
      measured: 3,
      medianMs: 3 * DAY,
      slowestMs: 7 * DAY,
    });
  });

  /**
   * Retention deletes exports. A decision whose render is gone still counts as a decision; only
   * its latency stops being measurable, which is why the two carry separate denominators.
   */
  it("counts a decision whose render retention deleted, but does not time it", () => {
    const status = summariseEditorialProgram(
      summaryInput({
        reviews: [
          { decision: ClipReviewDecision.ACCEPT, reviewerKind: ReviewerKind.HUMAN, createdAt: at(1), exportFinishedAt: null },
          { decision: ClipReviewDecision.ACCEPT, reviewerKind: ReviewerKind.HUMAN, createdAt: at(2), exportFinishedAt: at(1) },
        ],
      }),
    );
    expect(status.decisions.total).toBe(2);
    expect(status.reviewLatency.measured).toBe(1);
  });

  it("reports no latency at all when nothing can be timed", () => {
    expect(summariseEditorialProgram(summaryInput()).reviewLatency).toEqual({
      measured: 0,
      medianMs: null,
      slowestMs: null,
    });
  });

  it("carries each church's cohort through", () => {
    const status = summariseEditorialProgram(
      summaryInput({
        cohorts: [
          { workspaceId: "ws-1", churchName: "First Church", cohort: EditorialCohort.HUMAN_ONLY },
        ],
      }),
    );
    expect(status.cohorts).toEqual([
      { workspaceId: "ws-1", churchName: "First Church", cohort: EditorialCohort.HUMAN_ONLY },
    ]);
  });
});

describe("the evidence the start requires", () => {
  const proved: StartEvidence = {
    exactAcceptedRender: { scheduledPostId: "slot-1", exportJobId: "export-1", reviewId: "review-1" },
    atomicReplacement: { reviewId: "review-2", scheduledPostId: "slot-2", replacedClipId: "clip-2" },
    sandboxPublication: {
      scheduledPostId: "slot-1",
      exportJobId: "export-1",
      facebookPostId: "fb-1",
      publishedAt: START,
    },
  };

  it("names nothing when all three are proved", () => {
    expect(missingEvidence(proved)).toEqual([]);
  });

  it.each([
    ["exactAcceptedRender", "exact playback"],
    ["atomicReplacement", "atomic replacement"],
    ["sandboxPublication", "sandbox publication"],
  ] as const)("names %s when it is absent", (key, phrase) => {
    const missing = missingEvidence({ ...proved, [key]: null });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain(phrase);
  });

  it("names all three when the database can prove none of them", () => {
    expect(
      missingEvidence({
        exactAcceptedRender: null,
        atomicReplacement: null,
        sandboxPublication: null,
      }),
    ).toHaveLength(3);
  });
});
