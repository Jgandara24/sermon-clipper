import { describe, expect, it } from "vitest";
import { ClipApprovalState } from "@prisma/client";
import {
  approvalStateAfterEditorSave,
  createReviewToken,
  createReviewTokenExpiresAt,
  isClipApprovedForPublish,
  isManualExportAllowedWithoutApproval,
  isReviewLinkActive,
  publishApprovalBlockMessage,
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

describe("approval policy", () => {
  // Editorial approval gates what leaves the church's own hands — publishing and scheduling —
  // not what a member downloads from their own editor. Downloading an MP4 delivers nothing to
  // an audience, so gating it only taught people to approve clips they had no intent to post.
  it("never blocks a manual editor export, in any approval state", () => {
    for (const state of [
      ClipApprovalState.APPROVED,
      ClipApprovalState.IN_REVIEW,
      ClipApprovalState.CHANGES_REQUESTED,
      ClipApprovalState.DRAFT,
      null,
    ]) {
      expect(isManualExportAllowedWithoutApproval(state)).toBe(true);
    }
  });

  it("allows publishing and scheduling only after approval", () => {
    expect(isClipApprovedForPublish(ClipApprovalState.APPROVED)).toBe(true);
    expect(isClipApprovedForPublish(ClipApprovalState.IN_REVIEW)).toBe(false);
    expect(isClipApprovedForPublish(ClipApprovalState.CHANGES_REQUESTED)).toBe(false);
    expect(isClipApprovedForPublish(ClipApprovalState.DRAFT)).toBe(false);
    expect(isClipApprovedForPublish(null)).toBe(false);
  });

  it("explains why publishing is blocked, and never mentions export", () => {
    const messages = [
      publishApprovalBlockMessage(ClipApprovalState.IN_REVIEW),
      publishApprovalBlockMessage(ClipApprovalState.CHANGES_REQUESTED),
      publishApprovalBlockMessage(null),
    ];
    expect(messages[0]).toMatch(/still in review/i);
    expect(messages[1]).toMatch(/changes were requested/i);
    expect(messages[2]).toMatch(/send this clip for approval/i);
    for (const message of messages) {
      expect(message).not.toMatch(/export/i);
    }
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
