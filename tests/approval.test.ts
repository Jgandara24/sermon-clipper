import { describe, expect, it } from "vitest";
import { ClipApprovalState } from "@prisma/client";
import {
  approvalExportBlockMessage,
  approvalStateAfterEditorSave,
  createReviewToken,
  isClipApprovedForExport,
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
