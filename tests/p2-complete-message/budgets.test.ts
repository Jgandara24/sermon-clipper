import { describe, expect, it } from "vitest";
import { admit, FakeClock, packWholeSegments, rehearse, searchBlocks, WorkBudget, type Proposal } from "./harness";
import { deepFreeze } from "./fixtures";

const request = { inputTokens: 1, outputTokens: 1, elapsedMs: 0 };

function proposals(count: number, origin: Proposal["origin"] = "short"): Proposal[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${origin}-${String(i).padStart(4, "0")}`, origin,
    startMs: i * 5_000, endMs: i * 5_000 + (origin === "short" ? 30_000 : 152_000),
    result: { state: "complete", reason: "supplied_message_complete" },
  }));
}

describe("Stage 1 fake request budgets", () => {
  it("accepts 60 attempts and refuses the 61st before dispatch", () => {
    const budget = new WorkBudget(new FakeClock());
    for (let i = 0; i < 60; i++) expect(budget.request(request)).toBe(true);
    const before = { ...budget.counts };
    expect(budget.request(request)).toBe(false);
    expect(budget.stopReason).toBe("request_limit");
    expect(budget.counts).toEqual(before);
  });

  it("accepts exactly 12,000 input tokens per request", () => {
    const budget = new WorkBudget(new FakeClock());
    expect(budget.request({ ...request, inputTokens: 12_000 })).toBe(true);
    expect(budget.request({ ...request, inputTokens: 12_001 })).toBe(false);
    expect(budget.stopReason).toBe("context_budget_exceeded");
    expect(budget.counts.requests).toBe(1);
  });

  it("counts repeated context and retries toward 120,000 input tokens", () => {
    const budget = new WorkBudget(new FakeClock());
    for (let i = 0; i < 10; i++) expect(budget.request({ ...request, inputTokens: 12_000 })).toBe(true);
    expect(budget.request(request)).toBe(false);
    expect(budget.stopReason).toBe("input_token_limit");
    expect(budget.counts.inputTokens).toBe(120_000);
  });

  it("reserves exactly 24,000 output tokens and refuses another token", () => {
    const budget = new WorkBudget(new FakeClock());
    expect(budget.request({ ...request, outputTokens: 24_000 })).toBe(true);
    expect(budget.request(request)).toBe(false);
    expect(budget.stopReason).toBe("output_token_limit");
    expect(budget.counts.outputTokens).toBe(24_000);
  });

  it("accepts a request that finishes at exactly 60 seconds", () => {
    const clock = new FakeClock();
    const budget = new WorkBudget(clock);
    expect(budget.request({ ...request, elapsedMs: 60_000 })).toBe(true);
    expect(clock.milliseconds).toBe(60_000);
  });

  it("stops a slow request at 60 seconds without waiting", () => {
    const clock = new FakeClock();
    const budget = new WorkBudget(clock);
    expect(budget.request({ ...request, elapsedMs: 60_001 })).toBe(false);
    expect(budget.stopReason).toBe("request_time_limit");
    expect(clock.milliseconds).toBe(60_000);
    expect(budget.counts.requests).toBe(1);
    expect(budget.request(request)).toBe(false);
    expect(budget.counts.requests).toBe(1);
  });

  it("accepts completion at 300 seconds but refuses a further request", () => {
    const clock = new FakeClock();
    const budget = new WorkBudget(clock);
    for (let i = 0; i < 5; i++) expect(budget.request({ ...request, elapsedMs: 60_000 })).toBe(true);
    expect(clock.milliseconds).toBe(300_000);
    expect(budget.request(request)).toBe(false);
    expect(budget.stopReason).toBe("analysis_time_limit");
  });

  it("uses only the remaining analysis time for the last request", () => {
    const clock = new FakeClock();
    const budget = new WorkBudget(clock);
    clock.advance(299_999);
    expect(budget.request({ ...request, elapsedMs: 2 })).toBe(false);
    expect(clock.milliseconds).toBe(300_000);
    expect(budget.stopReason).toBe("analysis_time_limit");
  });

  it.each([-1, 0.5, NaN, Infinity])("rejects invalid token count %s", (inputTokens) => {
    const budget = new WorkBudget(new FakeClock());
    expect(budget.request({ ...request, inputTokens })).toBe(false);
    expect(budget.counts.requests).toBe(0);
  });

  it.each([
    ["request_limit", Array.from({ length: 61 }, () => request)],
    ["context_budget_exceeded", [{ ...request, inputTokens: 12_001 }]],
    ["input_token_limit", Array.from({ length: 11 }, () => ({ ...request, inputTokens: 12_000 }))],
    ["output_token_limit", [{ ...request, outputTokens: 24_001 }]],
    ["request_time_limit", [{ ...request, elapsedMs: 60_001 }]],
    ["analysis_time_limit", Array.from({ length: 6 }, () => ({ ...request, elapsedMs: 60_000 }))],
  ] as const)("preserves the saved pool after %s", (reason, requests) => {
    const saved = deepFreeze([{ id: "existing-local-fixture", startMs: 100, endMs: 30_100 }]);
    const result = rehearse(saved, [...requests], proposals(2), new FakeClock());
    expect(result.status).toBe("analysis_incomplete");
    expect(result.reason).toBe(reason);
    expect(result.savedPool).toBe(saved);
    expect(saved).toEqual([{ id: "existing-local-fixture", startMs: 100, endMs: 30_100 }]);
  });
});

describe("Stage 1 context and candidate bounds", () => {
  it("packs whole segments without losing or truncating text units", () => {
    const counts = new Map([["one", 7_000], ["two", 5_000], ["three", 1]]);
    expect(packWholeSegments(["one", "two", "three"], counts)).toEqual([["one", "two"], ["three"]]);
    counts.set("three", 12_001);
    expect(packWholeSegments(["one", "two", "three"], counts)).toBeUndefined();
    expect(packWholeSegments(["unknown"], counts)).toBeUndefined();
  });

  it("covers a 152-second message across a block boundary", () => {
    const blocks = searchBlocks(3_000_000);
    const message = { startMs: 300_000, endMs: 452_000 };
    expect(blocks.some((b) => b.startMs <= message.startMs && b.endMs >= message.endMs)).toBe(true);
    expect(blocks[1]).toEqual({ startMs: 180_000, endMs: 540_000, context: { startMs: 150_000, endMs: 570_000 } });
    expect(blocks).toHaveLength(16);
    expect(blocks[0].context.startMs).toBe(0);
    expect(blocks.at(-1)?.context.endMs).toBe(3_000_000);
  });

  it.each([500, 501])("caps %i proposals at 500", (count) => {
    const result = admit(proposals(count));
    expect(result.candidates).toHaveLength(500);
    expect(result.dropped).toBe(count - 500);
  });

  it.each([25, 26])("caps %i scoring candidates at 25", (count) => {
    expect(admit(proposals(count)).scoring).toHaveLength(25);
  });

  it("gives each proposal source 250 positions when both exceed their allocation", () => {
    const result = admit([...proposals(300), ...proposals(300, "message")]);
    expect(result.candidates.filter((p) => p.origin === "short")).toHaveLength(250);
    expect(result.candidates.filter((p) => p.origin === "message")).toHaveLength(250);
    expect(result.dropped).toBe(100);
  });

  it.each(["short", "message"] as const)("transfers unused capacity to %s proposals", (origin) => {
    expect(admit(proposals(501, origin)).candidates).toHaveLength(500);
  });

  it("keeps short and long proposals across an invented 50-minute source", () => {
    const pool = [...proposals(570), ...proposals(570, "message")];
    const result = admit(pool);
    for (const origin of ["short", "message"] as const) {
      for (const [start, end] of [[0, 1_000_000], [1_000_000, 2_000_000], [2_000_000, 3_000_000]]) {
        expect(result.candidates.some((p) => p.origin === origin && p.startMs >= start && p.startMs < end)).toBe(true);
      }
    }
    expect(result.candidates.every((p) => p.endMs <= 3_000_000)).toBe(true);
    expect(admit([...pool].reverse())).toEqual(result);
    expect(result.candidates.map((p) => p.startMs)).toEqual(result.candidates.map((p) => p.startMs).sort((a, b) => a - b));
  });

  it("keeps uncertain and incomplete proposals out without filling the count", () => {
    const pool = proposals(3);
    pool[1].result = { state: "incomplete", reason: "adapter_judgment" };
    pool[2].result = { state: "uncertain", reason: "missing_context" };
    expect(admit(pool).scoring.map((p) => p.id)).toEqual([pool[0].id]);
  });

  it("leaves overlapping proposals unchanged in this test stage", () => {
    const pool = proposals(2);
    pool[1].startMs = pool[0].startMs;
    pool[1].endMs = pool[0].endMs;
    expect(admit(pool).candidates).toHaveLength(2);
  });
});
