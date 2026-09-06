import { GeneratedClipStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  isPromotableReserve,
  selectReserve,
  type ReserveCandidate,
} from "@/lib/review/reserve-policy";

function candidate(overrides: Partial<ReserveCandidate> & { id: string; rank: number }): ReserveCandidate {
  return {
    status: GeneratedClipStatus.KEPT,
    startMs: 0,
    endMs: 60_000,
    isScheduled: false,
    ...overrides,
  };
}

describe("choosing the next clip in", () => {
  it("takes the lowest rank still available", () => {
    // Rank is the selector's ordering, so the lowest available rank is the next-best moment that
    // sermon produced.
    const result = selectReserve([
      candidate({ id: "c", rank: 9 }),
      candidate({ id: "a", rank: 3 }),
      candidate({ id: "b", rank: 5 }),
    ]);
    expect(result.selected?.id).toBe("a");
  });

  it("breaks a rank tie deterministically rather than by query order", () => {
    const forwards = selectReserve([candidate({ id: "b", rank: 4 }), candidate({ id: "a", rank: 4 })]);
    const backwards = selectReserve([candidate({ id: "a", rank: 4 }), candidate({ id: "b", rank: 4 })]);
    expect(forwards.selected?.id).toBe("a");
    expect(backwards.selected?.id).toBe("a");
  });

  it("never takes the clip being replaced", () => {
    const result = selectReserve(
      [candidate({ id: "rejected", rank: 1 }), candidate({ id: "next", rank: 6 })],
      { excludeClipIds: ["rejected"] },
    );
    expect(result.selected?.id).toBe("next");
  });

  it("never takes a clip another slot already holds", () => {
    const result = selectReserve([
      candidate({ id: "taken", rank: 1, isScheduled: true }),
      candidate({ id: "free", rank: 8 }),
    ]);
    expect(result.selected?.id).toBe("free");
  });
});

describe("what is not a reserve", () => {
  it("leaves a SUGGESTED clip alone, because nothing ever kept it", () => {
    // Promoting one would put a clip into a church's feed that the selector produced and then
    // decided against.
    const result = selectReserve([
      candidate({ id: "suggested", rank: 1, status: GeneratedClipStatus.SUGGESTED }),
      candidate({ id: "kept", rank: 7 }),
    ]);
    expect(result.selected?.id).toBe("kept");
  });

  it("leaves a HIDDEN clip alone, because a person already said no to it", () => {
    const result = selectReserve([
      candidate({ id: "hidden", rank: 2, status: GeneratedClipStatus.HIDDEN }),
      candidate({ id: "kept", rank: 7 }),
    ]);
    expect(result.selected?.id).toBe("kept");
  });

  it("leaves a SUPERSEDED clip alone, because it has been replaced out once already", () => {
    const result = selectReserve([
      candidate({ id: "gone", rank: 2, status: GeneratedClipStatus.SUPERSEDED }),
      candidate({ id: "kept", rank: 7 }),
    ]);
    expect(result.selected?.id).toBe("kept");
  });

  it("leaves a zero-length clip alone rather than trading a bad clip for a broken slot", () => {
    const result = selectReserve([
      candidate({ id: "empty", rank: 1, startMs: 5_000, endMs: 5_000 }),
      candidate({ id: "real", rank: 4 }),
    ]);
    expect(result.selected?.id).toBe("real");
    expect(isPromotableReserve(candidate({ id: "empty", rank: 1, startMs: 9, endMs: 4 }), new Set())).toBe(
      false,
    );
  });
});

describe("when the sermon has nothing left", () => {
  it("says so rather than returning something unsuitable", () => {
    const result = selectReserve([
      candidate({ id: "rejected", rank: 1 }),
      candidate({ id: "taken", rank: 2, isScheduled: true }),
      candidate({ id: "hidden", rank: 3, status: GeneratedClipStatus.HIDDEN }),
    ], { excludeClipIds: ["rejected"] });

    expect(result.selected).toBeNull();
    expect(result).toMatchObject({ reason: "NO_ELIGIBLE_RESERVE" });
  });

  it("says so for an empty pool", () => {
    expect(selectReserve([]).selected).toBeNull();
  });
});
