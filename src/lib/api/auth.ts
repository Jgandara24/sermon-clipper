import { getCurrentUser, getPrimaryWorkspaceMembershipForUser } from "@/lib/auth";
import {
  assertWorkspacePermission,
  WorkspaceAuthorizationError,
  type WorkspacePermission,
} from "@/lib/authorization";
import { apiError } from "./response";

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

  return { user, workspace: membership.workspace, membership } as const;
}
