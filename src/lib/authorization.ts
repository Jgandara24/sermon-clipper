import { WorkspaceRole } from "@prisma/client";

export type WorkspacePermission =
  | "VIEW_WORKSPACE"
  | "IMPORT_MEDIA"
  | "EDIT_CLIP"
  | "EXPORT_CLIP"
  | "REQUEST_APPROVAL"
  | "REVIEW_CLIP"
  | "MANAGE_TEMPLATES"
  | "MANAGE_MEMBERS"
  | "MANAGE_BILLING"
  | "MANAGE_OPERATIONS"
  | "MANAGE_WORKSPACE_PROFILE"
  | "MANAGE_SCHEDULE"
  | "MANAGE_FACEBOOK_CONNECTION"
  | "CANCEL_PROJECT";

const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
  [WorkspaceRole.OWNER]: new Set([
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
    // Deliberately OWNER-only, unlike every other MANAGE_* permission (which ADMIN also has):
    // this flag is what makes Tier 3 actually post to a real Facebook Page. See DECISIONS.md,
    // "Tier 3 Freeze Lifted" — the go-live gate is meant to be a real speed bump.
    "MANAGE_FACEBOOK_CONNECTION",
    "CANCEL_PROJECT",
  ]),
  [WorkspaceRole.ADMIN]: new Set([
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
    "CANCEL_PROJECT",
  ]),
  [WorkspaceRole.EDITOR]: new Set([
    "VIEW_WORKSPACE",
    "IMPORT_MEDIA",
    "EDIT_CLIP",
    "EXPORT_CLIP",
    "REQUEST_APPROVAL",
    "MANAGE_SCHEDULE",
    "CANCEL_PROJECT",
  ]),
  [WorkspaceRole.APPROVER]: new Set(["VIEW_WORKSPACE", "REVIEW_CLIP"]),
  [WorkspaceRole.VIEWER]: new Set(["VIEW_WORKSPACE"]),
};

export class WorkspaceAuthorizationError extends Error {
  constructor(
    readonly role: WorkspaceRole,
    readonly permission: WorkspacePermission,
  ) {
    super(`Workspace role ${role} does not have ${permission}.`);
  }
}

export function hasWorkspacePermission(role: WorkspaceRole, permission: WorkspacePermission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function assertWorkspacePermission(role: WorkspaceRole, permission: WorkspacePermission) {
  if (!hasWorkspacePermission(role, permission)) {
    throw new WorkspaceAuthorizationError(role, permission);
  }
}
