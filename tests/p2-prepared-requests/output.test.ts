import { describe, expect, it, vi } from "vitest";
import { finishWork, initialBudget, type Budget } from "@/lib/analysis/complete-message/budget";
import { planScoringBatches, type ScoringPacket, type BatchMeter } from "@/lib/analysis/complete-message/output-budget";
import { prepareRequest, preparedIdentity, reservePreparedRequest, type RequestRoute } from "@/lib/analysis/complete-message/prepared-request";

const route: RequestRoute = { stage: "analysis_scoring", provider: "google", model: "synthetic-scoring", schemaVersion: "test-v1" };
const packets = (n: number): ScoringPacket[] => Array.from({ length: n }, (_, i) => ({
  candidate: { id: `synthetic-${i}`, startMs: i * 30000, endMs: (i + 1) * 30000 },
  context: { words: Array.from({ length: 90 }, (_, w) => ({ id: `${i}:${w}`, text: "invented", startMs: i * 30000 + w * 300 })) },
  evidence: { claim: `synthetic-${i}`, resolution: `synthetic-${i}` },
}));
function plan(count: number, measure: BatchMeter["measure"], budget = initialBudget(0)) {
  return planScoringBatches({ route, packets: packets(count), budget, nowMs: 1 }, { supports: () => true, measure });
}

describe("complete scoring response bounds", () => {
  it("prepares and reserves each complete planned envelope without transport", () => {
    const bodyFor = (group: readonly ScoringPacket[]) => ({
      model: route.model, schema: { type: "object", required: ["scoredClips"] },
      messages: [{ role: "user", content: JSON.stringify(group) }], maxOutputTokens: 2048,
    });
    // Controlled accounting for this test, not a model tokenizer.
    const inputCount = (body: unknown) => 300 + Math.ceil(JSON.stringify(body).length / 10);
    const original = packets(3);
    let budget = initialBudget(0);
    const batches = planScoringBatches({ route, packets: original, budget, nowMs: 1 }, {
      supports: () => true,
      measure: (_, group) => ({ inputTokens: inputCount(bodyFor(group)), outputTokens: 100 + group.length * 900 }),
    });
    expect(batches.map((b) => b.packets.length)).toEqual([2, 1]);
    for (const [index, batch] of batches.entries()) {
      const request = prepareRequest({ route, body: bodyFor(batch.packets), maxOutputTokens: batch.maxOutputTokens }, {
        supports: () => true, measure: (envelope) => inputCount(envelope.body),
      });
      expect(request.inputReservation).toBe(batch.inputReservation);
      expect(JSON.parse(JSON.parse(request.bodyJson).messages[0].content)).toEqual(batch.packets);
      budget = reservePreparedRequest(budget, `call-${index}`, request, preparedIdentity(request), index + 1);
      expect(budget.stopReason).toBeNull();
      budget = finishWork(budget, { id: `call-${index}`, inputTokens: request.inputReservation,
        outputTokens: batch.outputBound }, index + 1);
      expect(budget.stopReason).toBeNull();
    }
    expect(budget).toMatchObject({ requests: 2, outputTokens: 4096, pending: null });
    expect(batches.flatMap((b) => b.packets)).toEqual(original);
  });
  it("splits ten candidates by output capacity and preserves their full context", () => {
    const inputPackets = packets(10), original = structuredClone(inputPackets), budget = initialBudget(0);
    const measure = vi.fn<BatchMeter["measure"]>((selectedRoute, group) => {
      expect(selectedRoute).toEqual(route);
      expect(Object.isFrozen(group[0].context)).toBe(true);
      // Controlled full-envelope and full-response bounds, not provider token measurements.
      return { inputTokens: 100 + group.length * 100, outputTokens: 60 + group.length * 300 };
    });
    const batches = planScoringBatches({ route, packets: inputPackets, budget, nowMs: 1 }, { supports: () => true, measure });
    expect(batches.map((b) => b.packets.length)).toEqual([6, 4]);
    expect(batches.flatMap((b) => b.packets)).toEqual(original);
    expect(batches.map((b) => b.outputBound)).toEqual([1860, 1260]);
    expect(batches.every((b) => b.maxOutputTokens === 2048)).toBe(true);
    expect(Object.isFrozen(batches)).toBe(true);
    expect(inputPackets).toEqual(original);
    expect(budget).toEqual(initialBudget(0));
  });
  it("also splits by complete input envelope size", () => {
    expect(plan(5, (_, group) => ({ inputTokens: 4000 * group.length, outputTokens: 100 }))
      .map((b) => b.packets.length)).toEqual([3, 2]);
  });
  it.each(["input", "output"])("refuses an oversized complete packet by %s, without a partial result", (kind) => {
    const budget = initialBudget(0);
    expect(() => plan(2, (_, group) => ({
      inputTokens: kind === "input" && JSON.stringify(group).includes("synthetic-1") ? 12001 : 100,
      outputTokens: kind === "output" && JSON.stringify(group).includes("synthetic-1") ? 2049 : 100,
    }), budget)).toThrow(kind === "input" ? "context_budget_exceeded" : "complete_response_exceeds_limit");
    expect(budget).toEqual(initialBudget(0));
  });
  it("accepts exact input and output boundaries", () => {
    expect(plan(1, () => ({ inputTokens: 12000, outputTokens: 2048 }))[0])
      .toMatchObject({ inputReservation: 12000, outputBound: 2048, maxOutputTokens: 2048 });
  });
  it.each([0, -1, NaN, Infinity, 1.1])("rejects invalid output bounds %s", (value) => {
    expect(() => plan(1, () => ({ inputTokens: 100, outputTokens: value }))).toThrow("invalid_token_bound");
  });
  it("does not invoke a meter for empty input or reduce repeated packets", () => {
    const measure = vi.fn(() => ({ inputTokens: 100, outputTokens: 100 }));
    expect(plan(0, measure)).toEqual([]);
    expect(measure).not.toHaveBeenCalled();
    const [packet] = packets(1);
    const result = planScoringBatches({ route, packets: [packet, packet], budget: initialBudget(0), nowMs: 1 },
      { supports: () => true, measure });
    expect(result[0].packets).toEqual([packet, packet]);
  });
  it("retains the 25-candidate limit", () => {
    expect(plan(25, () => ({ inputTokens: 100, outputTokens: 100 }))[0].packets).toHaveLength(25);
    expect(() => plan(26, () => ({ inputTokens: 100, outputTokens: 100 }))).toThrow("scoring_candidate_limit");
  });
  it.each([
    ["requests", 60, "request_limit"], ["inputTokens", 119901, "input_token_limit"],
    ["outputTokens", 21953, "output_token_limit"],
  ] as const)("checks aggregate %s before returning a plan", (key, value, reason) => {
    expect(() => plan(1, () => ({ inputTokens: 100, outputTokens: 1 }), { ...initialBudget(0), [key]: value })).toThrow(reason);
  });
  it("accepts exact aggregate limits and reserves full output caps", () => {
    const budget = { ...initialBudget(0), requests: 59, inputTokens: 119900, outputTokens: 21952 };
    expect(plan(1, () => ({ inputTokens: 100, outputTokens: 1 }), budget)).toHaveLength(1);
    expect(() => plan(2, (_, group) => ({ inputTokens: 100, outputTokens: group.length * 2048 }), budget)).toThrow("request_limit");
  });
  it("charges repeated request overhead for each split batch", () => {
    const budget = { ...initialBudget(0), inputTokens: 108000 };
    expect(() => plan(3, (_, group) => ({ inputTokens: 500 + group.length * 5500, outputTokens: 100 }), budget))
      .toThrow("input_token_limit");
    expect(budget.inputTokens).toBe(108000);
  });
  it("checks route support, time, pending work, and stopped budgets", () => {
    const data = { route, packets: packets(1), budget: initialBudget(0), nowMs: 1 };
    const meter: BatchMeter = { supports: () => true, measure: () => ({ inputTokens: 1, outputTokens: 1 }) };
    expect(() => planScoringBatches({ ...data, route: { ...route, stage: "analysis_classification" } }, meter)).toThrow("scoring_route_required");
    expect(() => planScoringBatches(data, { ...meter, supports: () => false })).toThrow("unsupported_meter_route");
    expect(() => planScoringBatches({ ...data, nowMs: 300000 }, meter)).toThrow("analysis_time_limit");
    expect(() => planScoringBatches({ ...data, nowMs: -1 }, meter)).toThrow("invalid_clock");
    const pending: Budget = { ...data.budget, pending: { id: "pending", inputTokens: 1, outputTokens: 1, startedAtMs: 0, deadlineMs: 100 } };
    expect(() => planScoringBatches({ ...data, budget: pending }, meter)).toThrow("request_pending");
    expect(() => planScoringBatches({ ...data, budget: { ...data.budget, stopReason: "stopped" } }, meter)).toThrow("stopped");
  });
});
