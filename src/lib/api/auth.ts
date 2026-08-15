import { getCurrentUser, getPrimaryWorkspaceMembershipForUser } from "@/lib/auth";
import {
  assertWorkspacePermission,
  WorkspaceAuthorizationError,
  type WorkspacePermission,
} from "@/lib/authorization";
import { apiError } from "./response";
import {
  decideWorkspaceAccess,
  workspaceAccessMessage,
  type WorkspaceAction,
} from "@/lib/billing/access";

function accessActionForPermission(permission?: WorkspacePermission): WorkspaceAction {
  if (permission === "MANAGE_BILLING") return "manage_billing";
  if (
    permission === "MANAGE_WORKSPACE_PROFILE" ||
    permission === "MANAGE_MEMBERS" ||
    permission === "MANAGE_OPERATIONS" ||
    permission === "CANCEL_PROJECT"
  ) {
    return "manage_settings";
  }
  if (permission === "IMPORT_MEDIA") return "import_media";
  if (permission === "EXPORT_CLIP") return "export_clip";
  if (permission === "MANAGE_SCHEDULE" || permission === "MANAGE_FACEBOOK_CONNECTION") {
    return "schedule_post";
  }
  return permission ? "start_processing" : "read";
}

/**
 * Route-handler equivalent of requireCurrentUser/requirePrimaryWorkspace: those redirect (fine
 * for pages/server actions), but an API route needs a 401/403 JSON error instead of a redirect.
 */
export async function requireApiWorkspace(permission?: WorkspacePermission) {
  const user = await getCurrentUser();
  if (!user) {
    return {
      error: apiError("PERMISSION_DENIED", "You don't have access to that workspace.", {
        status: 401,
      }),
    } as const;
  }

  const membership = await getPrimaryWorkspaceMembershipForUser(user.id);
  if (!membership) {
    return {
      error: apiError("PERMISSION_DENIED", "You don't have access to that workspace.", {
        status: 403,
      }),
    } as const;
  }

  if (permission) {
    try {
      assertWorkspacePermission(membership.role, permission);
    } catch (error) {
      if (error instanceof WorkspaceAuthorizationError) {
        return {
          error: apiError("PERMISSION_DENIED", "Your role can't do that.", { status: 403 }),
        } as const;
      }
      throw error;
    }
  }


  const access = decideWorkspaceAccess(membership.workspace, accessActionForPermission(permission));
  if (!access.allowed) {
    return {
      error: apiError(
        access.state === "lapsed" ? "SUBSCRIPTION_ENDED" : "TRIAL_EXPIRED",
        workspaceAccessMessage(access),
        { status: 402 },
      ),
    } as const;
  }

  return { user, workspace: membership.workspace, membership } as const;
}
