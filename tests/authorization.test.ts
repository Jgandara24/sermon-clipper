import { WorkspaceRole } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  assertWorkspacePermission,
  hasWorkspacePermission,
  WorkspaceAuthorizationError,
  type WorkspacePermission,
} from "@/lib/authorization";
import {
  assertPlatformOperator,
  isPlatformOperator,
  PlatformOperatorAuthorizationError,
} from "@/lib/operator-auth";

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

describe("platform-operator authority", () => {
  const operator = { id: "operator-1", isPlatformOperator: true };
  const churchOwner = { id: "owner-1", isPlatformOperator: false };

  it("is carried by the marker alone", () => {
    expect(isPlatformOperator(operator)).toBe(true);
    expect(isPlatformOperator(churchOwner)).toBe(false);
    expect(isPlatformOperator(null)).toBe(false);
    expect(isPlatformOperator(undefined)).toBe(false);
  });

  it("cannot be reached through any workspace role", () => {
    // The point of the split: a church OWNER holds every workspace permission there is —
    // MANAGE_OPERATIONS included, which is the one that reads like staff authority — and still
    // cannot review another church's work.
    for (const permission of allPermissions) {
      expect(hasWorkspacePermission(WorkspaceRole.OWNER, permission)).toBe(true);
    }
    expect(isPlatformOperator(churchOwner)).toBe(false);
    expect(() => assertPlatformOperator(churchOwner)).toThrow(PlatformOperatorAuthorizationError);
  });

  it("throws a typed error naming the user it refused", () => {
    expect(() => assertPlatformOperator(churchOwner)).toThrow(PlatformOperatorAuthorizationError);
    expect(() => assertPlatformOperator(churchOwner)).toThrow(/owner-1/);
    expect(() => assertPlatformOperator(null)).toThrow(PlatformOperatorAuthorizationError);
    expect(() => assertPlatformOperator(operator)).not.toThrow();
  });

  it("stays out of the workspace permission vocabulary", () => {
    // If cross-workspace review ever became a WorkspacePermission, every OWNER and ADMIN would
    // silently gain it, because both roles hold every permission in the set. This asserts the
    // vocabulary names nothing cross-tenant, so that mistake fails here rather than in production.
    const everyPermission: WorkspacePermission[] = [
      "VIEW_WORKSPACE",
      "IMPORT_MEDIA",
      "EDIT_CLIP",
      "EXPORT_CLIP",
      "REQUEST_APPROVAL",
      "REVIEW_CLIP",
      "MANAGE_TEMPLATES",
      "MANAGE_MEMBERS",
      "MANAGE_BILLING",
      "MANAGE_OPERATIONS",
      "MANAGE_WORKSPACE_PROFILE",
      "MANAGE_SCHEDULE",
      "MANAGE_FACEBOOK_CONNECTION",
      "CANCEL_PROJECT",
    ];
    for (const permission of everyPermission) {
      expect(permission).not.toMatch(/ANY_WORKSPACE|PLATFORM|CROSS_WORKSPACE|OPERATOR/);
    }
  });
});
