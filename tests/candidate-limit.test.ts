import { describe, expect, it } from "vitest";
import { readTargetClipCount, resolveCandidateLimit } from "@/lib/analysis/candidate-limit";

describe("readTargetClipCount", () => {
  it("uses six when project configuration has no valid scheduled count", () => {
    expect(readTargetClipCount({})).toBe(6);
  });
});

describe("resolveCandidateLimit", () => {
  it("uses the code fallback when no controls or override are set", () => {
    expect(resolveCandidateLimit({ targetClipCount: 6 })).toBe(18);
  });

  it("caps the master default at the master maximum", () => {
    expect(
      resolveCandidateLimit({
        targetClipCount: 6,
        masterDefault: 24,
        masterMaximum: 20,
      }),
    ).toBe(20);
  });

  it("uses a lower hidden church override", () => {
    expect(
      resolveCandidateLimit({
        targetClipCount: 6,
        churchOverride: 12,
        masterDefault: 18,
        masterMaximum: 18,
      }),
    ).toBe(12);
  });

  it("ignores an invalid hidden church override", () => {
    expect(
      resolveCandidateLimit({
        targetClipCount: 6,
        churchOverride: 12.5,
        masterDefault: 18,
        masterMaximum: 18,
      }),
    ).toBe(18);
  });

  it("caps a hidden church override at the master maximum", () => {
    expect(
      resolveCandidateLimit({
        targetClipCount: 6,
        churchOverride: 24,
        masterDefault: 16,
        masterMaximum: 18,
      }),
    ).toBe(18);
  });

  it("does not return fewer candidates than the scheduled count", () => {
    expect(
      resolveCandidateLimit({
        targetClipCount: 6,
        churchOverride: 3,
        masterDefault: 18,
        masterMaximum: 18,
      }),
    ).toBe(6);
  });
});
