import { describe, expect, it, vi } from "vitest";
import { planMessageRequests } from "../../src/lib/analysis/complete-message/requests";
import { budgetStatus, finishWork, initialBudget, reserveWork } from "../../src/lib/analysis/complete-message/budget";
import { admitDecisions } from "../../src/lib/analysis/complete-message/admission";
import type { Accepted, Decision } from "../../src/lib/analysis/complete-message/policy";
import { deepFreeze, sentenceNotMessage, transcript } from "../p2-complete-message/fixtures";
import { decision, makeCase } from "./fixtures";

describe("Stage 2 complete-message request groups", () => {
  it("keeps a complete message and intervening context in one request", () => {
    const f = makeCase(sentenceNotMessage());
    const measure = vi.fn(() => 12_000);
    const groups = [{ id: "whole-message", segmentIds: [f.source.segments[0].id, f.source.segments[3].id] }];
    const result = planMessageRequests(deepFreeze(f.source), deepFreeze(groups), measure);
    expect(result.status).toBe("complete");
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ inputTokens: 12_000, segmentIds: f.source.segments.map((s) => s.id) });
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("does not split a complete message when its request needs 12,001 tokens", () => {
    const f = makeCase(sentenceNotMessage());
    const result = planMessageRequests(f.source, [{ id: "whole", segmentIds: f.request.segmentIds }], () => 12_001);
    expect(result).toEqual({ status: "analysis_incomplete", reason: "context_budget_exceeded", requests: [], inputTokens: 0 });
  });

  it("includes whole adjacent segments even when the context edge crosses their timestamps", () => {
    const f = makeCase(transcript([40_000, 30_000, 40_000]));
    const result = planMessageRequests(f.source, [{ id: "middle", segmentIds: [f.source.segments[1].id] }], () => 100);
    expect(result.requests[0].segmentIds).toEqual(f.request.segmentIds);
  });

  it("counts repeated context and refuses an over-budget plan without returning partial requests", () => {
    const f = makeCase();
    const groups = Array.from({ length: 11 }, (_, i) => ({ id: `request-${i}`, segmentIds: f.request.segmentIds }));
    expect(planMessageRequests(f.source, groups.slice(0, 10), () => 12_000).inputTokens).toBe(120_000);
    expect(planMessageRequests(f.source, groups, () => 12_000)).toEqual({ status: "analysis_incomplete", reason: "input_token_limit", requests: [], inputTokens: 0 });
  });

  it.each([60, 61])("bounds %i request groups", (count) => {
    const f = makeCase();
    const groups = Array.from({ length: count }, (_, i) => ({ id: `request-${i}`, segmentIds: f.request.segmentIds }));
    expect(planMessageRequests(f.source, groups, () => 1).status).toBe(count === 60 ? "complete" : "analysis_incomplete");
  });

  it("reports missing context without calling the token meter", () => {
    const f = makeCase();
    const measure = vi.fn(() => 100);
    const result = planMessageRequests(f.source, [{ id: "missing", segmentIds: ["absent"] }], measure);
    expect(result.status).toBe("analysis_incomplete");
    expect(measure).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, NaN, Infinity])("refuses invalid token measurement %s", (count) => {
    const f = makeCase();
    const result = planMessageRequests(f.source, [{ id: "one", segmentIds: f.request.segmentIds }], () => count);
    expect(result.status).toBe("analysis_incomplete");
  });

  it("reports a failed token meter without creating requests", () => {
    const f = makeCase();
    expect(planMessageRequests(f.source, [{ id: "one", segmentIds: f.request.segmentIds }], () => { throw new Error("fake"); }))
      .toMatchObject({ status: "analysis_incomplete", reason: "token_measurement_failed", requests: [] });
  });
});

describe("Stage 2 pure work reservations", () => {
  const request = { id: "fake-request", inputTokens: 1, outputTokens: 1 };

  it("leaves the original state unchanged and retains reservations after a response", () => {
    const original = deepFreeze(initialBudget(0));
    const reserved = reserveWork(original, { ...request, outputTokens: 100 }, 0);
    const finished = finishWork(deepFreeze(reserved), request, 1);
    expect(original.requests).toBe(0);
    expect(reserved.pending).not.toBeNull();
    expect(finished.pending).toBeNull();
    expect(finished.outputTokens).toBe(100);
    expect(budgetStatus(finished)).toBe("complete");
  });

  it("requires a response before another reservation", () => {
    const state = reserveWork(initialBudget(0), request, 0);
    expect(budgetStatus(state)).toBe("analysis_incomplete");
    expect(reserveWork(state, request, 0).stopReason).toBe("request_pending");
  });

  it("counts retries and scoring requests toward the same 60-request limit", () => {
    let state = initialBudget(0);
    for (let i = 0; i < 60; i++) {
      state = finishWork(reserveWork(state, request, i), request, i);
      expect(state.stopReason).toBeNull();
    }
    const refused = reserveWork(state, request, 60);
    expect(refused.stopReason).toBe("request_limit");
    expect(refused.requests).toBe(60);
  });

  it.each([
    [12_000, 1, null], [12_001, 1, "context_budget_exceeded"],
    [1, 24_000, null], [1, 24_001, "output_token_limit"],
  ] as const)("checks token reservation %i / %i", (inputTokens, outputTokens, reason) => {
    expect(reserveWork(initialBudget(0), { ...request, inputTokens, outputTokens }, 0).stopReason).toBe(reason);
  });

  it("reserves exactly 120,000 input tokens, then refuses further input", () => {
    let state = initialBudget(0);
    const large = { ...request, inputTokens: 12_000 };
    for (let i = 0; i < 10; i++) state = finishWork(reserveWork(state, large, i), large, i);
    expect(state.inputTokens).toBe(120_000);
    expect(reserveWork(state, request, 10).stopReason).toBe("input_token_limit");
  });

  it("counts output across requests", () => {
    const large = { ...request, outputTokens: 24_000 };
    const state = finishWork(reserveWork(initialBudget(0), large, 0), large, 0);
    expect(reserveWork(state, request, 0).stopReason).toBe("output_token_limit");
  });

  it.each([60_000, 60_001])("checks request completion at %i milliseconds", (time) => {
    const state = finishWork(reserveWork(initialBudget(0), request, 0), request, time);
    expect(state.stopReason).toBe(time === 60_000 ? null : "request_time_limit");
  });

  it("uses the remaining analysis time as the final request deadline", () => {
    const state = reserveWork(initialBudget(0), request, 299_999);
    expect(state.pending?.deadlineMs).toBe(300_000);
    expect(finishWork(state, request, 300_000).stopReason).toBeNull();
    expect(finishWork(state, request, 300_001).stopReason).toBe("analysis_time_limit");
    expect(reserveWork(initialBudget(0), request, 300_000).stopReason).toBe("analysis_time_limit");
  });

  it("rejects mismatched response identity and usage above the reservation", () => {
    const state = reserveWork(initialBudget(0), request, 0);
    expect(finishWork(state, { ...request, id: "wrong" }, 0).stopReason).toBe("request_mismatch");
    expect(finishWork(state, { ...request, inputTokens: 2 }, 0).stopReason).toBe("reservation_exceeded");
  });

  it("rejects clocks that move backward", () => {
    const state = reserveWork(initialBudget(10), request, 11);
    expect(finishWork(state, request, 10).stopReason).toBe("invalid_clock");
  });

  it("keeps stopped work closed to further attempts", () => {
    const state = reserveWork(initialBudget(0), { ...request, inputTokens: 12_001 }, 0);
    expect(reserveWork(state, request, 1)).toBe(state);
    expect(budgetStatus(state)).toBe("analysis_incomplete");
  });
});

describe("Stage 2 duration-band admission", () => {
  function pool(count: number, duration: number, origin: "short" | "message"): Accepted[] {
    const accepted = decision(makeCase(transcript([duration])));
    if (accepted.state !== "complete") throw new Error("The synthetic message must pass validation.");
    return Array.from({ length: count }, (_, i) => ({
      ...accepted, id: `${origin}-${duration}-${String(i).padStart(4, "0")}`, origin,
      content: { startMs: i * 5_000, endMs: i * 5_000 + duration },
      range: { startMs: i * 5_000, endMs: i * 5_000 + duration },
    }));
  }

  it("retains short and extended message proposals within each origin allocation", () => {
    const decisions = [...pool(300, 30_000, "short"), ...pool(300, 45_000, "message"), ...pool(300, 152_000, "message")];
    const result = admitDecisions(decisions);
    expect(result.candidates).toHaveLength(500);
    expect(result.candidates.filter((p) => p.origin === "short")).toHaveLength(250);
    expect(result.candidates.filter((p) => p.origin === "message" && p.band === "standard")).toHaveLength(125);
    expect(result.candidates.filter((p) => p.band === "extended")).toHaveLength(125);
    expect(result.scoring).toHaveLength(25);
    expect(result.scoring.filter((p) => p.band === "extended")).toHaveLength(12);
    expect(admitDecisions([...decisions].reverse())).toEqual(result);
  });

  it.each([500, 501])("caps %i complete proposals", (count) => {
    const result = admitDecisions(pool(count, 30_000, "message"));
    expect(result.candidates).toHaveLength(500);
    expect(result.counts.omittedByCapacity).toBe(count - 500);
  });

  it.each([25, 26])("caps %i scoring candidates", (count) => {
    expect(admitDecisions(pool(count, 30_000, "message")).scoring).toHaveLength(25);
  });

  it("samples both duration bands across an invented 50-minute source", () => {
    const result = admitDecisions([...pool(570, 30_000, "message"), ...pool(570, 152_000, "message")]);
    for (const band of ["standard", "extended"]) {
      for (const start of [0, 1_000_000, 2_000_000]) {
        expect(result.candidates.some((p) => p.band === band && p.content.startMs >= start && p.content.startMs < start + 1_000_000)).toBe(true);
      }
    }
    expect(result.coverage).toEqual({ earliestStartMs: 0, latestEndMs: 2_997_000 });
  });

  it("does not admit incomplete, uncertain, or rejected decisions", () => {
    const decisions: Decision[] = [
      ...pool(1, 30_000, "message"),
      { id: "incomplete", state: "incomplete", reason: "missing_ending" },
      { id: "uncertain", state: "uncertain", reason: "missing_context" },
      { id: "rejected", state: "rejected", reason: "excluded_region" },
    ];
    const result = admitDecisions(deepFreeze(decisions));
    expect(result.candidates).toHaveLength(1);
    expect(result.counts.omittedByPolicy).toBe(3);
    expect(result.counts.omittedByCapacity).toBe(0);
  });

  it("leaves overlapping complete clips available", () => {
    const proposals = pool(2, 30_000, "message");
    proposals[1].range = { ...proposals[0].range };
    proposals[1].content = { ...proposals[0].content };
    expect(admitDecisions(proposals).candidates).toHaveLength(2);
  });
});
