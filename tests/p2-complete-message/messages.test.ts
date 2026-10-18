import { describe, expect, it, vi } from "vitest";
import { inspectProposal } from "./harness";
import { deepFreeze, earlierContext, judgment, segmentRange, sentenceNotMessage, shortComplete, transcript } from "./fixtures";

describe("Stage 1 supplied message judgments", () => {
  it("keeps the complete 56.620-second message without adding speech", () => {
    const f = shortComplete();
    const adapter = vi.fn((input: typeof f.input) => judgment(input));
    const before = structuredClone(f.input);
    deepFreeze(f.input);
    const result = inspectProposal(f.input, f.range, adapter(f.input), 0);
    expect(result).toEqual({ state: "complete", reason: "supplied_message_complete", range: {
      startMs: f.offset, endMs: f.offset + 56_620,
    } });
    expect(adapter.mock.calls[0]).toEqual([f.input]);
    expect(f.input).toEqual(before);
  });

  it("stops the 37.590-second message before announcements", () => {
    const f = transcript([18_000, 19_590, 8_000], [
      "Small acts of care matter.", "Daily care helps our neighbors flourish.", "Next week the club meets on Tuesday and",
    ]);
    const range = segmentRange(f.input, 0, 1);
    f.input.regions.push({ ...segmentRange(f.input, 2, 2), kind: "excluded" });
    const result = inspectProposal(f.input, range, judgment(f.input, [0, 1]));
    expect(result.state).toBe("complete");
    expect(result.range?.endMs).toBe(f.offset + 37_590);
    expect(inspectProposal(f.input, f.range, judgment(f.input, [0, 1])).reason).toBe("excluded_region");
  });

  it("keeps the 32.230-second thought separate from the next subject", () => {
    const f = transcript([16_000, 16_230, 20_000]);
    const result = inspectProposal(f.input, segmentRange(f.input, 0, 1), judgment(f.input, [0, 1]), 0);
    expect(result.range).toEqual({ startMs: f.offset, endMs: f.offset + 32_230 });
  });

  it("rejects a complete sentence at 67 seconds when the message needs 152 seconds", () => {
    const f = sentenceNotMessage();
    const response = judgment(f.input);
    expect(f.input.segments[1].text.endsWith(".")).toBe(true);
    expect(inspectProposal(f.input, segmentRange(f.input, 0, 1), response, 0)).toEqual({
      state: "incomplete", reason: "required_context_outside_range",
    });
    expect(inspectProposal(f.input, f.range, response, 0).range).toEqual({
      startMs: f.offset, endMs: f.offset + 152_000,
    });
  });

  it("leaves an unresolved explanation without an invented endpoint", () => {
    const f = transcript([30_000], ["The reason this matters is"]);
    const response = { ...judgment(f.input), state: "uncertain", unresolvedContext: true };
    expect(inspectProposal(f.input, f.range, response)).toEqual({ state: "uncertain", reason: "missing_context" });
  });

  it("requires the earlier 15 seconds within the complete 103-second comparison", () => {
    const f = earlierContext();
    const response = judgment(f.input);
    expect(inspectProposal(f.input, segmentRange(f.input, 1, 3), response).state).toBe("incomplete");
    expect(inspectProposal(f.input, f.range, response, 0).range).toEqual({
      startMs: f.offset, endMs: f.offset + 103_000,
    });
  });

  it("keeps the response with the objection", () => {
    const f = shortComplete();
    expect(inspectProposal(f.input, segmentRange(f.input, 0, 1), judgment(f.input)).state).toBe("incomplete");
  });

  it("keeps a complete 45-second range available before unrelated examples", () => {
    const f = transcript([20_000, 25_000, 60_000]);
    const result = inspectProposal(f.input, segmentRange(f.input, 0, 1), judgment(f.input, [0, 1]), 0);
    expect(result.range).toEqual({ startMs: f.offset, endMs: f.offset + 45_000 });
  });

  it("uses supplied dependencies without punctuation or capitals", () => {
    const f = transcript([20_000, 25_000], ["a young tree needs steady care", "regular water lets its roots grow"]);
    expect(inspectProposal(f.input, f.range, judgment(f.input), 0).state).toBe("complete");
  });

  it("keeps caption corrections outside source text, word times, and selection", () => {
    const f = transcript([30_000], ["the the gardener May waters the sees"]);
    const response = judgment(f.input);
    const before = structuredClone(f.input);
    deepFreeze(f.input);
    const notes = [
      { kind: "editorial", wordId: f.input.segments[0].words[0].id, text: "" },
      { kind: "recognition", wordId: f.input.segments[0].words.at(-1)!.id, text: "seeds" },
      { kind: "name_review", wordId: f.input.segments[0].words[3].id, text: "Mae" },
    ];
    const original = inspectProposal(f.input, f.range, response, 0);
    notes[0].text = "the";
    expect(inspectProposal(f.input, f.range, response, 0)).toEqual(original);
    expect(f.input).toEqual(before);
    expect(notes.map((note) => note.kind)).toEqual(["editorial", "recognition", "name_review"]);
  });

  it("refuses an internal announcement without joining separated ranges", () => {
    const f = transcript([20_000, 5_000, 30_000]);
    f.input.regions.push({ ...segmentRange(f.input, 1, 1), kind: "excluded" });
    expect(inspectProposal(f.input, f.range, judgment(f.input, [0, 2]))).toEqual({
      state: "rejected", reason: "excluded_region",
    });
  });

  it.each(["incomplete", "uncertain"] as const)("does not promote a supplied %s judgment", (state) => {
    const f = shortComplete();
    expect(inspectProposal(f.input, f.range, { ...judgment(f.input), state }).state).toBe(state);
  });
});

describe("Stage 1 evidence and missing context", () => {
  it.each([null, {}, { state: "complete" }])("refuses a malformed answer: %j", (response) => {
    const f = shortComplete();
    expect(inspectProposal(f.input, f.range, response).reason).toBe("malformed_judgment");
  });

  it("refuses unsupported quoted text", () => {
    const f = shortComplete();
    const response = judgment(f.input);
    response.evidence[0].quote = "This sentence never appears in the transcript.";
    expect(inspectProposal(f.input, f.range, response).reason).toBe("unsupported_evidence");
  });

  it("refuses an invented evidence identifier", () => {
    const f = shortComplete();
    const response = judgment(f.input);
    response.evidence[0].segmentId = "invented";
    expect(inspectProposal(f.input, f.range, response).reason).toBe("unsupported_evidence");
  });

  it("leaves absent required context uncertain", () => {
    const f = shortComplete();
    const response = judgment(f.input);
    response.requiredIds.push("context-outside-this-block");
    expect(inspectProposal(f.input, f.range, response).reason).toBe("missing_context");
  });

  it("requires support for each stated dependency", () => {
    const f = shortComplete();
    const response = judgment(f.input);
    response.evidence.pop();
    expect(inspectProposal(f.input, f.range, response).reason).toBe("missing_evidence");
  });

  it.each(["requiredIds", "evidence"] as const)("refuses repeated %s", (field) => {
    const f = shortComplete();
    const response = judgment(f.input);
    if (field === "requiredIds") response.requiredIds.push(response.requiredIds[0]);
    else response.evidence.push(response.evidence[0]);
    expect(inspectProposal(f.input, f.range, response).reason).toBe("duplicate_reference");
  });

  it("does not reuse a judgment from another transcript revision", () => {
    const f = shortComplete();
    expect(inspectProposal(f.input, f.range, { ...judgment(f.input), revision: "old" }).reason).toBe("transcript_changed");
  });

  it("gives each fixture independent identifiers and timestamps", () => {
    const a = shortComplete();
    const b = shortComplete();
    expect(a.input.segments[0].id).not.toBe(b.input.segments[0].id);
    expect(a.offset).not.toBe(b.offset);
  });
});
