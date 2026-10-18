import { describe, expect, it, vi } from "vitest";
import { initialBudget } from "@/lib/analysis/complete-message/budget";
import { prepareRequest, verifyPreparedRequest, reservePreparedRequest, snapshotJson, preparedIdentity,
  type RequestRoute, type InputMeter } from "@/lib/analysis/complete-message/prepared-request";

const route: RequestRoute = { stage: "analysis_classification", provider: "anthropic", model: "synthetic-model", schemaVersion: "test-v1" };
const meter = (count = 100): InputMeter => ({ supports: vi.fn(() => true), measure: vi.fn(() => count) });
const input = () => ({ route: { ...route }, maxOutputTokens: 1024,
  body: { model: route.model, schema: { type: "object" }, messages: [{ role: "user", content: "Invented context. Ω" }], max_tokens: 1024 } });

describe("immutable prepared requests", () => {
  it.each(["anthropic", "google"] as const)("records %s route and complete envelope", (provider) => {
    const source = input(), m = meter();
    source.route.provider = provider;
    const request = prepareRequest(source, m);
    expect(m.supports).toHaveBeenCalledWith(source.route);
    expect(m.measure).toHaveBeenCalledOnce();
    expect(m.measure).toHaveBeenCalledWith(expect.objectContaining({ body: source.body, route: source.route,
      bodyJson: expect.stringContaining("Invented context. Ω"), maxOutputTokens: 1024 }));
    expect(request.bodyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(request.bodyJson)).toEqual(source.body);
    source.body.messages[0].content = "changed";
    source.route.model = "changed-model";
    expect(request.bodyJson).not.toContain("changed");
    expect(request.route.model).toBe("synthetic-model");
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.body)).toBe(true);
    expect(() => verifyPreparedRequest(request, preparedIdentity(request))).not.toThrow();
  });
  it("passes a deeply frozen snapshot to the meter", () => {
    const m: InputMeter = { supports: () => true, measure: (request) => {
      const b = request.body as { messages: Array<{ content: string }> };
      expect(() => { b.messages[0].content = "changed"; }).toThrow();
      return 100;
    } };
    expect(prepareRequest(input(), m).inputReservation).toBe(100);
  });
  it("has stable identity across object key order", () => {
    const a = prepareRequest({ ...input(), body: { z: 1, a: { b: 2, a: 1 } } }, meter());
    const b = prepareRequest({ ...input(), body: { a: { a: 1, b: 2 }, z: 1 } }, meter());
    expect(a).toEqual(b);
  });
  it.each(["body", "bodyJson", "bodyDigest", "inputReservation", "envelopeDigest"] as const)("detects changed %s", (field) => {
    const request = prepareRequest(input(), meter());
    const tampered = { ...request, [field]: field === "body" ? {} : field === "inputReservation" ? 101 : "changed" };
    expect(() => verifyPreparedRequest(tampered, preparedIdentity(request))).toThrow("request_digest_changed");
  });
  it.each(["provider", "model", "stage", "schemaVersion"] as const)("rejects a changed expected %s", (field) => {
    const request = prepareRequest(input(), meter());
    const changed = { ...route, [field]: field === "provider" ? "google" : field === "stage" ? "analysis_scoring" : "different" };
    expect(() => verifyPreparedRequest(request, { ...preparedIdentity(request), route: changed as RequestRoute }))
      .toThrow("request_identity_changed");
  });
  it("rejects an output limit change", () => {
    const request = prepareRequest(input(), meter());
    expect(() => verifyPreparedRequest(request, { ...preparedIdentity(request), maxOutputTokens: 1000 })).toThrow("request_identity_changed");
  });
  it("rejects substitution with another internally valid prepared request", () => {
    const original = prepareRequest(input(), meter());
    const identity = preparedIdentity(original);
    const replacement = prepareRequest({ ...input(), body: { different: "complete but not reserved" } }, meter());
    expect(() => verifyPreparedRequest(replacement, identity)).toThrow("request_identity_changed");
    expect(() => reservePreparedRequest(initialBudget(0), "reserved", replacement, identity, 1)).toThrow("request_identity_changed");
  });
  it("refuses unsupported routes before measuring", () => {
    const m = meter(); m.supports = () => false;
    expect(() => prepareRequest(input(), m)).toThrow("unsupported_meter_route");
    expect(m.measure).not.toHaveBeenCalled();
    expect(() => prepareRequest({ ...input(), route: { ...route, provider: "other" } as never }, meter())).toThrow("invalid_route");
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("refuses invalid measured bound %s", (count) => {
    expect(() => prepareRequest(input(), meter(count))).toThrow("invalid_token_bound");
  });
  it("checks exact input and stage output limits", () => {
    expect(prepareRequest(input(), meter(12000)).inputReservation).toBe(12000);
    expect(() => prepareRequest(input(), meter(12001))).toThrow("context_budget_exceeded");
    expect(() => prepareRequest({ ...input(), maxOutputTokens: 1025 }, meter())).toThrow("output_request_limit");
    const scoring = { ...input(), route: { ...route, stage: "analysis_scoring" as const }, maxOutputTokens: 2048 };
    expect(prepareRequest(scoring, meter()).maxOutputTokens).toBe(2048);
    expect(() => prepareRequest({ ...scoring, maxOutputTokens: 2049 }, meter())).toThrow("output_request_limit");
  });
  it("reserves through the existing budget without changing the input state", () => {
    const budget = initialBudget(1000), request = prepareRequest(input(), meter(12000));
    const next = reservePreparedRequest(budget, "call-1", request, preparedIdentity(request), 1010);
    expect(next).toMatchObject({ requests: 1, inputTokens: 12000, outputTokens: 1024,
      pending: { id: "call-1", deadlineMs: 61010 } });
    expect(budget).toEqual(initialBudget(1000));
    expect(reservePreparedRequest(next, "call-2", request, preparedIdentity(request), 1010).stopReason).toBe("request_pending");
    expect(reservePreparedRequest(budget, "late", request, preparedIdentity(request), 301000).stopReason).toBe("analysis_time_limit");
  });
});

describe("lossless JSON boundary", () => {
  it.each([undefined, NaN, Infinity, BigInt(1), () => 1, new Date(), new Map(), [undefined], Array(1)])
    ("refuses non-JSON or lossy data %s", (value) => expect(() => snapshotJson(value)).toThrow());
  it("rejects cycles and getters without invoking them", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => snapshotJson(cyclic)).toThrow("invalid_json");
    const get = vi.fn(() => "hidden");
    expect(() => snapshotJson(Object.defineProperty({}, "text", { get, enumerable: true }))).toThrow("invalid_json");
    expect(get).not.toHaveBeenCalled();
  });
  it("preserves repeated references as independent frozen values and safe property names", () => {
    const shared = { text: "invented" };
    expect(snapshotJson([shared, shared])).toEqual([shared, shared]);
    const unusual = JSON.parse('{"__proto__":{"safe":true}}');
    expect(JSON.stringify(snapshotJson(unusual))).toBe(JSON.stringify(unusual));
  });
});
