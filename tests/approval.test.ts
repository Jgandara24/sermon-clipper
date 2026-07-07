import { describe, expect, it } from "vitest";
import { ClipApprovalState } from "@prisma/client";
import {
  approvalExportBlockMessage,
  approvalStateAfterEditorSave,
  createReviewToken,
  createReviewTokenExpiresAt,
  isClipApprovedForExport,
  isReviewLinkActive,
  reviewLinkUnavailableReason,
} from "@/lib/approval";

describe("createReviewToken", () => {
  it("creates opaque URL-safe review tokens", () => {
    const token = createReviewToken();

    expect(token.length).toBeGreaterThanOrEqual(30);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not reuse tokens", () => {
    expect(createReviewToken()).not.toBe(createReviewToken());
  });
});

describe("approval export policy", () => {
  it("allows export only after approval", () => {
    expect(isClipApprovedForExport(ClipApprovalState.APPROVED)).toBe(true);
    expect(isClipApprovedForExport(ClipApprovalState.IN_REVIEW)).toBe(false);
    expect(isClipApprovedForExport(ClipApprovalState.CHANGES_REQUESTED)).toBe(false);
    expect(isClipApprovedForExport(null)).toBe(false);
  });

  it("explains why export is blocked", () => {
    expect(approvalExportBlockMessage(ClipApprovalState.IN_REVIEW)).toMatch(/still in review/i);
    expect(approvalExportBlockMessage(ClipApprovalState.CHANGES_REQUESTED)).toMatch(/changes were requested/i);
    expect(approvalExportBlockMessage(null)).toMatch(/send this clip for approval/i);
  });

  it("invalidates approved clips after editor saves", () => {
    expect(approvalStateAfterEditorSave(ClipApprovalState.APPROVED)).toBe(ClipApprovalState.DRAFT);
    expect(approvalStateAfterEditorSave(ClipApprovalState.IN_REVIEW)).toBeNull();
    expect(approvalStateAfterEditorSave(ClipApprovalState.CHANGES_REQUESTED)).toBeNull();
    expect(approvalStateAfterEditorSave(null)).toBeNull();
  });
});

describe("review link safety", () => {
  it("sets review token expiry fourteen days out", () => {
    const now = new Date("2026-07-07T12:00:00Z");

    expect(createReviewTokenExpiresAt(now)).toEqual(new Date("2026-07-21T12:00:00Z"));
  });

  it("marks expired and revoked links inactive", () => {
    const now = new Date("2026-07-07T12:00:00Z");
    const active = { reviewTokenExpiresAt: new Date("2026-07-08T12:00:00Z"), reviewTokenRevokedAt: null };
    const expired = { reviewTokenExpiresAt: new Date("2026-07-06T12:00:00Z"), reviewTokenRevokedAt: null };
    const revoked = {
      reviewTokenExpiresAt: new Date("2026-07-08T12:00:00Z"),
      reviewTokenRevokedAt: new Date("2026-07-07T11:00:00Z"),
    };

    expect(isReviewLinkActive(active, now)).toBe(true);
    expect(reviewLinkUnavailableReason(active, now)).toBeNull();
    expect(isReviewLinkActive(expired, now)).toBe(false);
    expect(reviewLinkUnavailableReason(expired, now)).toBe("expired");
    expect(isReviewLinkActive(revoked, now)).toBe(false);
    expect(reviewLinkUnavailableReason(revoked, now)).toBe("revoked");
  });
});
