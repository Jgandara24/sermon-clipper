import {
  ClipReviewDecision,
  ReviewFeedbackActionability,
  ReviewFeedbackCategory,
} from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  defaultActionability,
  isTrimmableAtEdge,
  replaceOnlyCategories,
  requiredDecision,
  resolveActionability,
} from "@/lib/review/feedback-policy";
import { assertIdentityIsCurrent, clipDurationMs } from "@/lib/review/snapshots";
import { StaleRenderError, type ReviewedRenderIdentity } from "@/lib/review/types";

const DURATION = 60_000;

function finding(
  category: ReviewFeedbackCategory,
  span?: { startMs: number; endMs: number },
) {
  return { category, note: "n", ...span };
}

describe("the S15 actionability table", () => {
  it("makes a content defect replace-only, however mild it sounds", () => {
    // Nothing the editor can do to this clip fixes the point never landing.
    expect(defaultActionability(finding(ReviewFeedbackCategory.CONTENT), DURATION)).toBe(
      ReviewFeedbackActionability.REPLACE_ONLY,
    );
  });

  it("makes presentation defects revisable, however ugly they look", () => {
    for (const category of [
      ReviewFeedbackCategory.BOUNDARY,
      ReviewFeedbackCategory.VISUAL_CROP,
      ReviewFeedbackCategory.CAPTION,
      ReviewFeedbackCategory.AUDIO_LEVEL,
      ReviewFeedbackCategory.TITLE_HOOK,
    ]) {
      expect(defaultActionability(finding(category), DURATION)).toBe(
        ReviewFeedbackActionability.REVISABLE,
      );
    }
  });

  it("covers every category the enum declares", () => {
    // A category added without a row here must not quietly become cheap.
    for (const category of Object.values(ReviewFeedbackCategory)) {
      expect(defaultActionability(finding(category), DURATION)).toBeDefined();
    }
  });
});

describe("forbidden content, where the position decides", () => {
  const forbidden = ReviewFeedbackCategory.FORBIDDEN_CONTENT;

  it("is revisable at either edge, because a trim leaves one continuous range", () => {
    expect(
      defaultActionability(finding(forbidden, { startMs: 0, endMs: 4_000 }), DURATION),
    ).toBe(ReviewFeedbackActionability.REVISABLE);
    expect(
      defaultActionability(finding(forbidden, { startMs: 56_000, endMs: DURATION }), DURATION),
    ).toBe(ReviewFeedbackActionability.REVISABLE);
  });

  it("is replace-only mid-clip, because a trim would leave two ranges", () => {
    expect(
      defaultActionability(finding(forbidden, { startMs: 20_000, endMs: 24_000 }), DURATION),
    ).toBe(ReviewFeedbackActionability.REPLACE_ONLY);
  });

  it("is replace-only when nobody said where it is", () => {
    // Fails closed. One unnecessary replacement costs less than publishing forbidden content.
    expect(defaultActionability(finding(forbidden), DURATION)).toBe(
      ReviewFeedbackActionability.REPLACE_ONLY,
    );
    expect(
      defaultActionability(finding(forbidden, { startMs: 0, endMs: 4_000 }), 0),
    ).toBe(ReviewFeedbackActionability.REPLACE_ONLY);
  });

  it("treats a span running past the end as reaching the end", () => {
    expect(
      isTrimmableAtEdge({ category: forbidden, startMs: 58_000, endMs: 70_000 }, DURATION),
    ).toBe(true);
  });

  it("does not treat a half-located span as trimmable", () => {
    expect(isTrimmableAtEdge({ category: forbidden, startMs: 0, endMs: null }, DURATION)).toBe(false);
    expect(isTrimmableAtEdge({ category: forbidden, startMs: null, endMs: 4_000 }, DURATION)).toBe(
      false,
    );
  });
});

describe("a reviewer's own actionability", () => {
  it("wins over the table, and is what gets stored", () => {
    // Stored per row so a later change to the table cannot rewrite what a past finding demanded.
    const stated = {
      category: ReviewFeedbackCategory.CAPTION,
      note: "n",
      actionability: ReviewFeedbackActionability.REPLACE_ONLY,
    };
    expect(resolveActionability(stated, DURATION)).toBe(ReviewFeedbackActionability.REPLACE_ONLY);
    expect(resolveActionability({ category: ReviewFeedbackCategory.CAPTION, note: "n" }, DURATION)).toBe(
      ReviewFeedbackActionability.REVISABLE,
    );
  });
});

describe("the decision a set of findings requires", () => {
  it("is ACCEPT when nothing is asked for", () => {
    expect(requiredDecision([], DURATION)).toBe(ClipReviewDecision.ACCEPT);
  });

  it("is REVISE when every finding can be fixed by re-editing", () => {
    expect(
      requiredDecision(
        [finding(ReviewFeedbackCategory.CAPTION), finding(ReviewFeedbackCategory.BOUNDARY)],
        DURATION,
      ),
    ).toBe(ClipReviewDecision.REVISE);
  });

  it("is REPLACE as soon as one finding cannot be, because a clip is not half-replaced", () => {
    expect(
      requiredDecision(
        [
          finding(ReviewFeedbackCategory.CAPTION),
          finding(ReviewFeedbackCategory.BOUNDARY),
          finding(ReviewFeedbackCategory.CONTENT),
        ],
        DURATION,
      ),
    ).toBe(ClipReviewDecision.REPLACE);
  });

  it("names the findings a REVISE cannot honour", () => {
    expect(
      replaceOnlyCategories(
        [
          finding(ReviewFeedbackCategory.CAPTION),
          finding(ReviewFeedbackCategory.CONTENT),
          finding(ReviewFeedbackCategory.FORBIDDEN_CONTENT, { startMs: 20_000, endMs: 21_000 }),
        ],
        DURATION,
      ),
    ).toEqual([ReviewFeedbackCategory.CONTENT, ReviewFeedbackCategory.FORBIDDEN_CONTENT]);
    expect(replaceOnlyCategories([finding(ReviewFeedbackCategory.CAPTION)], DURATION)).toEqual([]);
  });
});

describe("the exact-render check", () => {
  const subject = {
    workspaceId: "w",
    projectId: "p",
    scheduledPostId: "slot-1",
    clipId: "clip-1",
    clipRank: 1,
    clipStartMs: 10_000,
    clipEndMs: 70_000,
    exportJobId: "export-1",
    editVersion: 3,
    checksum: "sha256:abc",
    slotSnapshot: {},
  };
  const current: ReviewedRenderIdentity = {
    clipId: "clip-1",
    exportJobId: "export-1",
    editVersion: 3,
    checksum: "sha256:abc",
  };

  it("measures the clip from its own span, not from zero", () => {
    expect(clipDurationMs(subject)).toBe(60_000);
  });

  it("passes when all four facts match", () => {
    expect(() => assertIdentityIsCurrent(subject, current)).not.toThrow();
  });

  it.each([
    ["a replaced clip", { clipId: "clip-2" }],
    ["a rerender", { exportJobId: "export-2" }],
    ["a newer edit", { editVersion: 4 }],
    ["a rebuilt file with the same export id", { checksum: "sha256:def" }],
  ])("refuses %s", (_label, drift) => {
    expect(() => assertIdentityIsCurrent(subject, { ...current, ...drift })).toThrow(
      StaleRenderError,
    );
  });

  it("names every fact that moved, not just the first", () => {
    try {
      assertIdentityIsCurrent(subject, {
        clipId: "clip-2",
        exportJobId: "export-2",
        editVersion: 9,
        checksum: "sha256:zzz",
      });
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(StaleRenderError);
      const message = (error as StaleRenderError).message;
      expect(message).toContain("clip clip-2 is now clip-1");
      expect(message).toContain("export export-2 is now export-1");
      expect(message).toContain("edit version 9 is now 3");
      expect(message).toContain("checksum changed");
    }
  });
});
