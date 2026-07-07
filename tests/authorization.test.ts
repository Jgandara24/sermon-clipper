import { WorkspaceRole } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  assertWorkspacePermission,
  hasWorkspacePermission,
  WorkspaceAuthorizationError,
  type WorkspacePermission,
} from "@/lib/authorization";

const allPermissions: WorkspacePermission[] = [
  "VIEW_WORKSPACE",
  "IMPORT_MEDIA",
  "EDIT_CLIP",
  "EXPORT_CLIP",
  "REQUEST_APPROVAL",
  "REVIEW_CLIP",
  "MANAGE_TEMPLATES",
  "MANAGE_BILLING",
  "MANAGE_OPERATIONS",
  "CANCEL_PROJECT",
];

describe("workspace role permissions", () => {
  it("allows owners and admins to perform all workspace operations", () => {
    for (const role of [WorkspaceRole.OWNER, WorkspaceRole.ADMIN]) {
      for (const permission of allPermissions) {
        expect(hasWorkspacePermission(role, permission)).toBe(true);
      }
    }
  });

  it("allows editors to run the clip workflow without managing admin surfaces", () => {
    expect(hasWorkspacePermission(WorkspaceRole.EDITOR, "VIEW_WORKSPACE")).toBe(true);
    expect(hasWorkspacePermission(WorkspaceRole.EDITOR, "IMPORT_MEDIA")).toBe(true);
    expect(hasWorkspacePermission(WorkspaceRole.EDITOR, "EDIT_CLIP")).toBe(true);
    expect(hasWorkspacePermission(WorkspaceRole.EDITOR, "EXPORT_CLIP")).toBe(true);
    expect(hasWorkspacePermission(WorkspaceRole.EDITOR, "REQUEST_APPROVAL")).toBe(true);
    expect(hasWorkspacePermission(WorkspaceRole.EDITOR, "CANCEL_PROJECT")).toBe(true);
    expect(hasWorkspacePermission(WorkspaceRole.EDITOR, "REVIEW_CLIP")).toBe(false);
    expect(hasWorkspacePermission(WorkspaceRole.EDITOR, "MANAGE_TEMPLATES")).toBe(false);
    expect(hasWorkspacePermission(WorkspaceRole.EDITOR, "MANAGE_BILLING")).toBe(false);
    expect(hasWorkspacePermission(WorkspaceRole.EDITOR, "MANAGE_OPERATIONS")).toBe(false);
  });

  it("limits approvers to viewing and reviewing clips", () => {
    expect(hasWorkspacePermission(WorkspaceRole.APPROVER, "VIEW_WORKSPACE")).toBe(true);
    expect(hasWorkspacePermission(WorkspaceRole.APPROVER, "REVIEW_CLIP")).toBe(true);
    expect(hasWorkspacePermission(WorkspaceRole.APPROVER, "IMPORT_MEDIA")).toBe(false);
    expect(hasWorkspacePermission(WorkspaceRole.APPROVER, "EDIT_CLIP")).toBe(false);
    expect(hasWorkspacePermission(WorkspaceRole.APPROVER, "EXPORT_CLIP")).toBe(false);
    expect(hasWorkspacePermission(WorkspaceRole.APPROVER, "REQUEST_APPROVAL")).toBe(false);
    expect(hasWorkspacePermission(WorkspaceRole.APPROVER, "MANAGE_TEMPLATES")).toBe(false);
    expect(hasWorkspacePermission(WorkspaceRole.APPROVER, "MANAGE_BILLING")).toBe(false);
    expect(hasWorkspacePermission(WorkspaceRole.APPROVER, "MANAGE_OPERATIONS")).toBe(false);
    expect(hasWorkspacePermission(WorkspaceRole.APPROVER, "CANCEL_PROJECT")).toBe(false);
  });

  it("limits viewers to read-only workspace access", () => {
    expect(hasWorkspacePermission(WorkspaceRole.VIEWER, "VIEW_WORKSPACE")).toBe(true);
    for (const permission of allPermissions.filter((item) => item !== "VIEW_WORKSPACE")) {
      expect(hasWorkspacePermission(WorkspaceRole.VIEWER, permission)).toBe(false);
    }
  });

  it("throws a typed authorization error for denied permissions", () => {
    expect(() => assertWorkspacePermission(WorkspaceRole.VIEWER, "EXPORT_CLIP")).toThrow(
      WorkspaceAuthorizationError,
    );
  });
});
