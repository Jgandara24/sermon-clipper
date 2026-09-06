import { ClipReviewDecision, ReviewFeedbackCategory, ReviewFeedbackSeverity } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { APPENDABLE_DECISIONS, decisionSchema, readFeedbackRows } from "@/lib/review/decision-input";

// Real v4 UUIDs. Zod 4 checks the version and variant nibbles, not merely the shape, so a
// repeated-digit placeholder is rejected — `gen_random_uuid()` produces v4 and passes.
const IDENTITY = {
  scheduledPostId: "0f1d8d2e-6f4a-4a1e-9c2b-5b6d7e8f9012",
  clipId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  exportJobId: "2b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e",
  editVersion: "4",
  checksum: "sha256:abc",
};

function form(entries: [string, string][]): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

function finding(
  note: string,
  overrides?: Partial<{ category: string; severity: string; startMs: string; endMs: string }>,
): [string, string][] {
  return [
    ["feedbackCategory", overrides?.category ?? ReviewFeedbackCategory.CAPTION],
    ["feedbackSeverity", overrides?.severity ?? ReviewFeedbackSeverity.MAJOR],
    ["feedbackNote", note],
    ["feedbackStartMs", overrides?.startMs ?? ""],
    ["feedbackEndMs", overrides?.endMs ?? ""],
  ];
}

describe("the decision a form may carry", () => {
  it("accepts ACCEPT and REVISE with the identity the reviewer watched", () => {
    for (const decision of APPENDABLE_DECISIONS) {
      const parsed = decisionSchema.parse({ ...IDENTITY, decision });
      expect(parsed.decision).toBe(decision);
      // The version arrives as a string from a form and must reach the service as a number.
      expect(parsed.editVersion).toBe(4);
    }
  });

  it("refuses REPLACE, which is the lock a disabled button is not", () => {
    // The UI shows the control disabled. A disabled button is a suggestion; a direct POST is not
    // obliged to honour it, and a Server Action is reachable by direct POST.
    expect(() =>
      decisionSchema.parse({ ...IDENTITY, decision: ClipReviewDecision.REPLACE }),
    ).toThrow();
    expect(() => decisionSchema.parse({ ...IDENTITY, decision: "replace" })).toThrow();
    expect(() => decisionSchema.parse({ ...IDENTITY, decision: "" })).toThrow();
  });

  it("refuses an identity that is not a set of real ids", () => {
    expect(() =>
      decisionSchema.parse({ ...IDENTITY, decision: "ACCEPT", clipId: "not-a-uuid" }),
    ).toThrow();
    expect(() =>
      decisionSchema.parse({ ...IDENTITY, decision: "ACCEPT", checksum: "" }),
    ).toThrow();
    expect(() =>
      decisionSchema.parse({ ...IDENTITY, decision: "ACCEPT", editVersion: "-1" }),
    ).toThrow();
  });
});

describe("reading several findings out of one submission", () => {
  it("zips the parallel arrays a repeated form field produces", () => {
    const data = form([
      ...finding("Caption sits over the chin."),
      ...finding("Starts a sentence early.", {
        category: ReviewFeedbackCategory.BOUNDARY,
        severity: ReviewFeedbackSeverity.MINOR,
        startMs: "0",
        endMs: "1500",
      }),
      ...finding("The point never lands.", { category: ReviewFeedbackCategory.CONTENT }),
    ]);

    const findings = readFeedbackRows(data);
    expect(findings).toHaveLength(3);
    expect(findings[0]).toMatchObject({
      category: ReviewFeedbackCategory.CAPTION,
      note: "Caption sits over the chin.",
      startMs: null,
      endMs: null,
    });
    expect(findings[1]).toMatchObject({
      category: ReviewFeedbackCategory.BOUNDARY,
      severity: ReviewFeedbackSeverity.MINOR,
      startMs: 0,
      endMs: 1500,
    });
    expect(findings[2].category).toBe(ReviewFeedbackCategory.CONTENT);
  });

  it("drops the blank row the form keeps for the next thought", () => {
    // Losing a written decision to a stray empty row would be a poor trade for strictness.
    const data = form([...finding("A real finding."), ...finding("   ")]);
    expect(readFeedbackRows(data)).toHaveLength(1);
    expect(readFeedbackRows(form(finding("")))).toEqual([]);
  });

  it("refuses a position that is not whole milliseconds", () => {
    expect(() => readFeedbackRows(form(finding("n", { startMs: "1.5", endMs: "2" })))).toThrow();
    expect(() => readFeedbackRows(form(finding("n", { startMs: "abc", endMs: "2" })))).toThrow();
    // An empty position is not a bad one: it means the finding is not located.
    expect(readFeedbackRows(form(finding("n", { startMs: "", endMs: "" })))[0]).toMatchObject({
      startMs: null,
    });
  });

  it("refuses a category or severity that is not in the vocabulary", () => {
    expect(() => readFeedbackRows(form(finding("n", { category: "WHATEVER" })))).toThrow();
    expect(() => readFeedbackRows(form(finding("n", { severity: "CATASTROPHIC" })))).toThrow();
  });

  it("takes every category the enum declares", () => {
    for (const category of Object.values(ReviewFeedbackCategory)) {
      expect(readFeedbackRows(form(finding("n", { category })))[0].category).toBe(category);
    }
  });
});
