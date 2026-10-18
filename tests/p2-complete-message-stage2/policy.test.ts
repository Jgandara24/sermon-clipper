import { describe, expect, it, vi } from "vitest";
import { evaluateResponse } from "../../src/lib/analysis/complete-message/policy";
import { deepFreeze, earlierContext, sentenceNotMessage, shortComplete, transcript } from "../p2-complete-message/fixtures";
import { decision, makeCase } from "./fixtures";

describe("Stage 2 independent message expectations", () => {
  it("preserves the complete 56.620-second message through a mocked adapter", () => {
    const f = makeCase(shortComplete());
    const before = structuredClone(f);
    deepFreeze(f);
    const adapter = vi.fn((_request: typeof f.request) => f.response);
    const result = evaluateResponse(f.source, f.request, adapter(f.request));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisions[0]).toMatchObject({
      state: "complete", band: "standard", content: { startMs: f.offset, endMs: f.offset + 56_620 },
      range: { startMs: f.offset - 150, endMs: f.offset + 56_770 },
    });
    expect(adapter).toHaveBeenCalledExactlyOnceWith(f.request);
    expect(f).toEqual(before);
  });

  it.each([37_590, 32_230])("ends a %i-millisecond message before the next subject", (duration) => {
    const f = makeCase(transcript([duration, 10_000], ["Daily care helps a garden grow.", "The club meeting starts tomorrow."]));
    f.proposal.end = { kind: "segment", id: f.source.segments[0].id };
    f.proposal.required = [{ ref: f.proposal.start!, quote: f.source.segments[0].text, roles: ["claim", "resolution"] }];
    f.source.regions.push({ startMs: f.offset + duration, endMs: f.offset + duration + 10_000, kind: "excluded" });
    expect(decision(f)).toMatchObject({ state: "complete", content: { endMs: f.offset + duration }, range: { endMs: f.offset + duration } });
    f.proposal.end = { kind: "segment", id: f.source.segments[1].id };
    expect(decision(f)).toMatchObject({ state: "rejected", reason: "excluded_region" });
  });

  it("requires 152 seconds when a sentence ends at 67 seconds", () => {
    const f = makeCase(sentenceNotMessage());
    f.proposal.end = { kind: "segment", id: f.source.segments[1].id };
    expect(decision(f)).toMatchObject({ state: "incomplete", reason: "required_context_outside_range" });
    f.proposal.end = { kind: "segment", id: f.source.segments[3].id };
    expect(decision(f)).toMatchObject({ state: "complete", band: "extended", content: { startMs: f.offset, endMs: f.offset + 152_000 } });
  });

  it("leaves an unresolved message uncertain without a range", () => {
    const f = makeCase();
    Object.assign(f.proposal, { state: "uncertain", start: null, end: null, required: [], missingContext: ["The explanation continues."] });
    expect(decision(f)).toEqual({ id: f.proposal.id, state: "uncertain", reason: "missing_context" });
  });

  it("requires earlier context within the full 103-second comparison", () => {
    const f = makeCase(earlierContext());
    f.proposal.start = { kind: "segment", id: f.source.segments[1].id };
    expect(decision(f)).toMatchObject({ state: "incomplete" });
    f.proposal.start = { kind: "segment", id: f.source.segments[0].id };
    expect(decision(f)).toMatchObject({ state: "complete", content: { startMs: f.offset, endMs: f.offset + 103_000 } });
  });

  it("preserves an objection with its response", () => {
    const f = makeCase(shortComplete());
    f.proposal.end = { kind: "segment", id: f.source.segments[1].id };
    expect(decision(f)).toMatchObject({ state: "incomplete" });
  });

  it("does not require punctuation", () => {
    const f = makeCase(transcript([30_000], ["a garden needs steady care throughout the year"]));
    expect(decision(f).state).toBe("complete");
  });

  it.each([
    [19_999, "rejected"], [20_000, "complete"], [90_000, "complete"], [90_001, "complete"],
    [103_000, "complete"], [152_000, "complete"], [180_000, "complete"], [180_001, "rejected"],
  ] as const)("checks %i milliseconds", (duration, state) => {
    const f = makeCase(transcript([duration]));
    const result = decision(f);
    expect(result.state).toBe(state);
    if (result.state === "complete") {
      expect(result.content).toEqual(f.range);
      expect(result.range.endMs - result.range.startMs).toBeLessThanOrEqual(180_000);
      expect(result.band).toBe(duration <= 90_000 ? "standard" : "extended");
    }
  });

  it("reduces padding before removing any of 179,900 milliseconds of required speech", () => {
    const f = makeCase(transcript([179_900]));
    expect(decision(f)).toMatchObject({ range: { startMs: f.offset - 100, endMs: f.offset + 179_900 } });
  });

  it("does not pad into unverified silence", () => {
    const f = makeCase();
    f.source.gaps = [];
    expect(decision(f)).toMatchObject({ state: "complete", range: f.range });
  });

  it("keeps exact source edges without padding outside them", () => {
    const f = makeCase();
    const segment = f.source.segments[0];
    segment.startMs -= f.offset;
    segment.endMs -= f.offset;
    for (const word of segment.words) { word.startMs -= f.offset; word.endMs -= f.offset; }
    f.source.sourceDurationMs = 30_000;
    f.source.regions = [{ startMs: 0, endMs: 30_000, kind: "allowed" }];
    f.source.gaps = [];
    expect(decision(f)).toMatchObject({ state: "complete", range: { startMs: 0, endMs: 30_000 } });
  });

  it("requires full region clearance", () => {
    const f = makeCase();
    f.source.regions = [{ startMs: f.offset, endMs: f.offset + 10_000, kind: "allowed" }];
    expect(decision(f)).toMatchObject({ state: "uncertain", reason: "region_uncertain" });
  });

  it("allows segment-only boundaries only with trusted boundary evidence", () => {
    const f = makeCase();
    f.source.segments[0].words = [];
    expect(decision(f)).toMatchObject({ state: "uncertain", reason: "boundary_uncertain" });
    f.source.segments[0].verifiedStart = true;
    f.source.segments[0].verifiedEnd = true;
    expect(decision(f).state).toBe("complete");
  });

  it("resolves an internal word boundary without including the next words", () => {
    const f = makeCase(transcript([60_000], ["Grow roots first then explain another subject"]));
    const words = f.source.segments[0].words;
    f.proposal.start = { kind: "word", id: words[0].id };
    f.proposal.end = { kind: "word", id: words[2].id };
    f.proposal.required = words.slice(0, 3).map((word, i) => ({
      ref: { kind: "word", id: word.id }, quote: word.text, roles: i === 0 ? ["claim"] : ["resolution"],
    }));
    expect(decision(f)).toMatchObject({ state: "complete", range: { endMs: words[2].endMs } });
  });

  it.each(["unmarked", "missing", "silence"] as const)("checks an internal %s gap", (kind) => {
    const f = makeCase(transcript([20_000, 20_000]));
    const second = f.source.segments[1];
    second.startMs += 500;
    // Move only the first word start, leaving a valid shorter first word.
    second.words[0].startMs += 500;
    if (kind !== "unmarked") f.source.gaps.push({ startMs: f.offset + 20_000, endMs: f.offset + 20_500, kind });
    expect(decision(f).state).toBe(kind === "silence" ? "complete" : "uncertain");
  });

  it("requires every intervening segment in the delivered context", () => {
    const f = makeCase(shortComplete());
    f.request.segmentIds.splice(1, 1);
    f.proposal.required.splice(1, 1);
    expect(decision(f)).toMatchObject({ state: "uncertain", reason: "missing_context" });
  });
});

describe("Stage 2 strict adapter validation", () => {
  it("rejects padded source identifiers instead of normalizing them", () => {
    const f = makeCase();
    f.source.segments[0].id = ` ${f.source.segments[0].id} `;
    expect(evaluateResponse(f.source, f.request, f.response)).toEqual({ ok: false, reason: "invalid_transcript" });
  });

  it("rejects padded response identifiers instead of normalizing them", () => {
    const f = makeCase();
    f.proposal.start!.id = ` ${f.proposal.start!.id} `;
    expect(evaluateResponse(f.source, f.request, f.response)).toEqual({ ok: false, reason: "malformed_response" });
  });

  it.each(["segment_order", "duplicate_id", "outside_source"])("refuses invalid source %s", (kind) => {
    const f = makeCase(shortComplete());
    if (kind === "segment_order") f.source.segments.reverse();
    if (kind === "duplicate_id") f.source.segments[1].id = f.source.segments[0].id;
    if (kind === "outside_source") f.source.sourceDurationMs = f.range.endMs - 1;
    const result = evaluateResponse(f.source, f.request, f.response);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(kind === "duplicate_id" ? "duplicate_source_id" : "invalid_segment_times");
  });

  it("refuses reversed boundaries derived from valid references", () => {
    const f = makeCase(shortComplete());
    f.proposal.start = { kind: "segment", id: f.source.segments[3].id };
    f.proposal.end = { kind: "segment", id: f.source.segments[0].id };
    expect(decision(f)).toMatchObject({ state: "rejected", reason: "invalid_range" });
  });

  it("rejects boundary claims supplied by the adapter", () => {
    const f = makeCase();
    const response = { ...f.response, proposals: [{ ...f.proposal, verifiedStart: true }] };
    expect(evaluateResponse(f.source, f.request, response)).toEqual({ ok: false, reason: "malformed_response" });
  });

  it("refuses an oversized response before selecting any proposal", () => {
    const f = makeCase();
    const response = { ...f.response, proposals: Array.from({ length: 501 }, (_, i) => ({ ...f.proposal, id: `p-${i}` })) };
    expect(evaluateResponse(f.source, f.request, response)).toEqual({ ok: false, reason: "malformed_response" });
  });

  it.each([null, [], {}, { version: 2 }])("refuses malformed response %j", (response) => {
    const f = makeCase();
    expect(evaluateResponse(f.source, f.request, response)).toEqual({ ok: false, reason: "malformed_response" });
  });

  it("refuses invented timestamps instead of accepting model-supplied precision", () => {
    const f = makeCase();
    expect(evaluateResponse(f.source, f.request, { ...f.response, startMs: 100 })).toEqual({ ok: false, reason: "malformed_response" });
  });

  it.each(["request", "response"] as const)("refuses an old %s revision", (side) => {
    const f = makeCase();
    f[side].revision = "old";
    expect(evaluateResponse(f.source, f.request, f.response)).toEqual({ ok: false, reason: "transcript_changed" });
  });

  it("binds the response to the request identity", () => {
    const f = makeCase();
    f.response.requestId = "other-request";
    expect(evaluateResponse(f.source, f.request, f.response)).toEqual({ ok: false, reason: "request_mismatch" });
  });

  it("refuses repeated proposal identifiers without removing overlapping clips", () => {
    const f = makeCase();
    f.response.proposals.push(structuredClone(f.proposal));
    expect(evaluateResponse(f.source, f.request, f.response)).toEqual({ ok: false, reason: "duplicate_proposal_id" });
    f.response.proposals[1].id += "-other";
    const result = evaluateResponse(f.source, f.request, f.response);
    expect(result.ok && result.decisions.every((d) => d.state === "complete")).toBe(true);
  });

  it.each([
    ["quote", "unsupported_quote"], ["reference", "unknown_reference"],
    ["duplicate", "duplicate_evidence"], ["role", "duplicate_role"],
    ["missing_roles", "missing_message_evidence"], ["contradiction", "contradictory_judgment"],
  ])("refuses invalid %s evidence", (kind, reason) => {
    const f = makeCase();
    if (kind === "quote") f.proposal.required[0].quote = "An invented quotation.";
    if (kind === "reference") f.proposal.required[0].ref.id = "invented";
    if (kind === "duplicate") f.proposal.required.push(f.proposal.required[0]);
    if (kind === "role") f.proposal.required[0].roles.push("claim");
    if (kind === "missing_roles") f.proposal.required[0].roles = ["context"];
    if (kind === "contradiction") f.proposal.missingContext = ["The earlier claim is missing."];
    expect(decision(f)).toMatchObject({ state: "rejected", reason });
  });

  it("refuses references to source text absent from the actual request", () => {
    const f = makeCase(shortComplete());
    f.request.segmentIds.pop();
    expect(decision(f)).toMatchObject({ state: "rejected", reason: "evidence_outside_request" });
  });

  it.each([undefined, 0, -1, 1.5, NaN, Infinity])("refuses invalid source duration %s", (duration) => {
    const f = makeCase();
    expect(evaluateResponse({ ...f.source, sourceDurationMs: duration }, f.request, f.response)).toEqual({ ok: false, reason: "invalid_transcript" });
  });

  it("refuses overlapping word timestamps", () => {
    const f = makeCase();
    f.source.segments[0].words[1].startMs--;
    expect(evaluateResponse(f.source, f.request, f.response)).toEqual({ ok: false, reason: "invalid_word_times" });
  });

  it("refuses a false silence label over spoken words", () => {
    const f = makeCase();
    f.source.gaps.push({ ...f.range, kind: "silence" });
    expect(evaluateResponse(f.source, f.request, f.response)).toEqual({ ok: false, reason: "coverage_conflict" });
  });
});
