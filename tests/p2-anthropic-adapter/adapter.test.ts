import { afterEach, describe, expect, it, vi } from "vitest";
import { DisconnectedAnthropicAdapter, MAX_MESSAGE_RESPONSE_BYTES,
  type MockableAnthropicTransport } from "@/lib/analysis/complete-message/anthropic-adapter";
import { prepareRequest, preparedIdentity, type InputMeter } from "@/lib/analysis/complete-message/prepared-request";

const payload = () => ({ request: { id: "request-1", revision: "revision-1", origin: "message", segmentIds: ["s1"] },
  segments: [{ id: "s1", text: "Invented complete context Ω", startMs: 0, endMs: 30000,
    words: [{ id: "w1", text: "Invented", startMs: 0, endMs: 500 }] }],
  regions: [{ startMs: 0, endMs: 30000, kind: "allowed" }],
});
const classification = () => ({ version: 1, requestId: "request-1", revision: "revision-1", proposals: [] });
function response(output: unknown = classification(), model = "synthetic-classify") {
  return { model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(output) }],
    usage: { input_tokens: 20, output_tokens: 40, cache_creation_input_tokens: 30, cache_read_input_tokens: 50 } };
}
function setup(count = 100, now: () => number = () => 1000) {
  const transport = vi.fn<MockableAnthropicTransport>(async () => response());
  const meter: InputMeter = { supports: vi.fn(() => true), measure: vi.fn(() => count) };
  const adapter = new DisconnectedAnthropicAdapter({
    analysis_classification: { model: "synthetic-classify", pricing: null },
    analysis_scoring: { model: "synthetic-score", pricing: null },
  }, meter, transport, now);
  const prepared = adapter.prepare("analysis_classification", payload());
  const identity = preparedIdentity(prepared);
  const call = (signal = new AbortController().signal) => adapter.dispatch(prepared, identity, signal);
  return { adapter, transport, meter, prepared, identity, call };
}
afterEach(() => vi.useRealTimers());

describe("disconnected Anthropic preparation and transport", () => {
  it("sends the exact measured body with complete context and no retries", async () => {
    const f = setup();
    expect(f.transport).not.toHaveBeenCalled();
    const body = JSON.parse(f.prepared.bodyJson);
    expect(JSON.parse(body.messages[0].content)).toEqual(payload());
    expect(body).toMatchObject({ model: "synthetic-classify", max_tokens: 1024,
      thinking: { type: "disabled" }, output_config: { format: { type: "json_schema" } } });
    const result = await f.call();
    expect(result).toMatchObject({ ok: true, usageState: "known", budget: { requests: 1, inputTokens: 100, outputTokens: 1024, pending: null },
      usage: { inputTokens: 20, outputTokens: 40, cacheCreationInputTokens: 30, cacheReadInputTokens: 50, outcome: "succeeded" } });
    expect(f.transport).toHaveBeenCalledExactlyOnceWith(f.prepared.bodyJson, {
      signal: expect.any(AbortSignal), maxRetries: 0, maxResponseBytes: MAX_MESSAGE_RESPONSE_BYTES,
    });
    expect(f.meter.measure).toHaveBeenCalledWith(expect.objectContaining({ bodyJson: f.prepared.bodyJson }));
  });
  it("rejects another valid prepared request against the retained identity", async () => {
    const f = setup();
    const other = f.adapter.prepare("analysis_classification", { ...payload(), additionalContext: "Keep this context." });
    expect(await f.adapter.dispatch(other, f.identity, new AbortController().signal))
      .toMatchObject({ ok: false, reason: "request_identity_changed", usageState: "not_requested" });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("refuses mismatched provider body fields before transport", async () => {
    const f = setup();
    const body = JSON.parse(f.prepared.bodyJson); body.max_tokens = 32000;
    const invalid = prepareRequest({ route: f.prepared.route, body, maxOutputTokens: 1024 }, f.meter);
    expect(await f.adapter.dispatch(invalid, preparedIdentity(invalid), new AbortController().signal))
      .toMatchObject({ reason: "provider_body_changed", usageState: "not_requested" });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("refuses another configured model or schema before transport", async () => {
    for (const change of [{ model: "other-model" }, { schemaVersion: "other-schema" }, { provider: "google" as const }]) {
      const f = setup();
      const invalid = prepareRequest({ route: { ...f.prepared.route, ...change }, body: f.prepared.body, maxOutputTokens: 1024 }, f.meter);
      expect(await f.adapter.dispatch(invalid, preparedIdentity(invalid), new AbortController().signal))
        .toMatchObject({ reason: "request_identity_changed" });
      expect(f.transport).not.toHaveBeenCalled();
    }
  });
  it("preserves known usage for malformed output and prevents retry", async () => {
    const f = setup(); const raw = response(); raw.content[0].text = "invalid JSON";
    f.transport.mockResolvedValue(raw);
    expect(await f.call()).toMatchObject({ ok: false, reason: "malformed_response", usageState: "known", usage: { outcome: "failed" } });
    expect((await f.call()).ok).toBe(false);
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it.each(["max_tokens", "refusal", "tool_use", "pause_turn", "unknown"])("refuses completion %s", async (reason) => {
    const f = setup(); f.transport.mockResolvedValue({ ...response(), stop_reason: reason });
    expect(await f.call()).toMatchObject({ ok: false, reason: reason === "max_tokens" ? "truncated_response" : "unexpected_completion", usageState: "known" });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it.each(["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"])("does not invent missing %s", async (field) => {
    const f = setup(), raw = response();
    delete (raw.usage as Record<string, number>)[field];
    f.transport.mockResolvedValue(raw);
    expect(await f.call()).toMatchObject({ ok: false, reason: "usage_unknown", usage: null, usageState: "unknown" });
  });
  it.each([-1, 1.5, NaN, Infinity])("rejects invalid usage %s", async (value) => {
    const f = setup(); f.transport.mockResolvedValue({ ...response(), usage: { ...response().usage, output_tokens: value } });
    expect(await f.call()).toMatchObject({ reason: "usage_unknown", usageState: "unknown" });
  });
  it("sums cache categories once and rejects usage above reservation", async () => {
    const f = setup(99);
    expect(await f.call()).toMatchObject({ reason: "reservation_exceeded", usageState: "known" });
  });
  it("rejects output usage above the cap", async () => {
    const f = setup(); f.transport.mockResolvedValue({ ...response(), usage: { ...response().usage, output_tokens: 1025 } });
    expect(await f.call()).toMatchObject({ reason: "reservation_exceeded", usageState: "known" });
  });
  it("records the actual mismatched model without assigning the requested model's price", async () => {
    const f = setup(); f.transport.mockResolvedValue(response(classification(), "different-model"));
    expect(await f.call()).toMatchObject({ reason: "response_model_changed", usage: { model: "different-model", pricing: null } });
  });
  it("keeps transport failures unknown and hides raw error details", async () => {
    const f = setup(); f.transport.mockRejectedValue(new Error("secret test diagnostic"));
    const result = await f.call();
    expect(result).toMatchObject({ reason: "adapter_failed", usageState: "unknown", usage: null });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it.each(["requestId", "revision"])("checks response %s", async (key) => {
    const f = setup(); f.transport.mockResolvedValue(response({ ...classification(), [key]: "changed" }));
    expect(await f.call()).toMatchObject({ reason: "response_identity_changed" });
  });
  it("checks byte bounds before parsing and rejects non-text output", async () => {
    const f = setup(); const raw = response(); raw.content[0].text = "x".repeat(MAX_MESSAGE_RESPONSE_BYTES + 1);
    f.transport.mockResolvedValue(raw);
    expect(await f.call()).toMatchObject({ reason: "response_byte_limit", usageState: "known" });
    const g = setup(); g.transport.mockResolvedValue({ ...response(), content: [{ type: "tool_use", id: "tool" }] });
    expect(await g.call()).toMatchObject({ reason: "invalid_content" });
  });
  it("preserves complete scoring output and requires every candidate once", async () => {
    for (const indexes of [[0, 1], [0], [0, 0], [0, 2]]) {
      const f = setup();
      const prepared = f.adapter.prepare("analysis_scoring", { candidates: [{ index: 0, context: "earlier" }, { index: 1, context: "later" }] });
      const output = { scoredClips: indexes.map((index) => ({ index, title: "Invented", hookText: "Care", summary: "Growth", excerpt: "Complete context",
        subscores: Object.fromEntries(["hookStrength", "clarity", "emotionalImpact", "completeness", "shareability", "topicRelevance"]
          .map((name) => [name, { score: 80, note: "Synthetic judgment." }])) })) };
      f.transport.mockResolvedValue(response(output, "synthetic-score"));
      const result = await f.adapter.dispatch(prepared, preparedIdentity(prepared), new AbortController().signal);
      if (indexes.join() === "0,1") {
        expect(result).toMatchObject({ ok: true, output, usage: { stage: "analysis_scoring", model: "synthetic-score" } });
        expect(JSON.parse(f.transport.mock.calls[0][0]).max_tokens).toBe(2048);
      } else expect(result).toMatchObject({ reason: "incomplete_scores" });
    }
  });
  it("refuses expired analysis and cumulative reservations without extra calls", async () => {
    let now = 0; const f = setup(12000, () => now);
    for (let i = 0; i < 10; i++) expect((await f.call()).ok).toBe(true);
    expect(await f.call()).toMatchObject({ reason: "input_token_limit", usageState: "not_requested" });
    expect(f.transport).toHaveBeenCalledTimes(10);
    const g = setup(100, () => now); now = 300000;
    expect(await g.call()).toMatchObject({ reason: "analysis_time_limit", usageState: "not_requested" });
    expect(g.transport).not.toHaveBeenCalled();
  });
  it("retains full output reservations rather than refunding unused tokens", async () => {
    const f = setup();
    for (let i = 0; i < 23; i++) expect((await f.call()).ok).toBe(true);
    expect(await f.call()).toMatchObject({ reason: "output_token_limit", usageState: "not_requested",
      budget: { requests: 23, outputTokens: 23552 } });
    expect(f.transport).toHaveBeenCalledTimes(23);
  });
  it("rejects schema overflow without removing response fields", async () => {
    const f = setup();
    f.transport.mockResolvedValue(response({ ...classification(), proposals: Array.from({ length: 33 }, (_, i) => ({
      id: `proposal-${i}`, state: "uncertain", start: null, end: null, required: [],
      missingContext: ["Earlier context"], reason: "Invented unresolved message.",
    })) }));
    expect(await f.call()).toMatchObject({ reason: "invalid_response_schema", usageState: "known" });
  });
  it("requires meter support and refuses oversized complete context before dispatch", () => {
    const f = setup(); f.meter.supports = () => false;
    expect(() => f.adapter.prepare("analysis_classification", payload())).toThrow("unsupported_meter_route");
    f.meter.supports = () => true; f.meter.measure = () => 12001;
    expect(() => f.adapter.prepare("analysis_classification", payload())).toThrow("context_budget_exceeded");
    expect(f.transport).not.toHaveBeenCalled();
  });
});

describe("cancellation without a live transport", () => {
  it("does not dispatch an already cancelled request", async () => {
    const f = setup(), controller = new AbortController(); controller.abort();
    expect(await f.call(controller.signal)).toMatchObject({ reason: "cancelled", usageState: "not_requested", budget: { requests: 0 } });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("forwards cancellation and settles even when the mock ignores it", async () => {
    const f = setup(), controller = new AbortController();
    f.transport.mockImplementation(() => new Promise(() => {}));
    const pending = f.call(controller.signal); await Promise.resolve(); controller.abort();
    expect(await pending).toMatchObject({ reason: "cancelled", usageState: "unknown" });
    expect(f.transport.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("enforces the request deadline and accepts no second concurrent call", async () => {
    vi.useFakeTimers();
    const f = setup(100, () => Date.now());
    f.transport.mockImplementation(() => new Promise(() => {}));
    const first = f.call(); await Promise.resolve();
    expect(await f.call()).toMatchObject({ reason: "request_pending", usageState: "not_requested" });
    await vi.advanceTimersByTimeAsync(60000);
    expect(await first).toMatchObject({ reason: "request_deadline", usageState: "unknown" });
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.transport.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
