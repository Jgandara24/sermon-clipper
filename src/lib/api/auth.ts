import { getCurrentUser, getPrimaryWorkspaceForUser } from "@/lib/auth";
import { apiError } from "./response";

/**
 * Route-handler equivalent of requireCurrentUser/requirePrimaryWorkspace: those redirect (fine
 * for pages/server actions), but an API route needs a 401/403 JSON error instead of a redirect.
 */
export async function requireApiWorkspace() {
  const user = await getCurrentUser();
  if (!user) {
    return {
      error: apiError("PERMISSION_DENIED", "You don't have access to that workspace.", {
        status: 401,
      }),
    } as const;
  }

  const workspace = await getPrimaryWorkspaceForUser(user.id);
  if (!workspace) {
    return {
      error: apiError("PERMISSION_DENIED", "You don't have access to that workspace.", {
        status: 403,
      }),
    } as const;
  }

  return { user, workspace } as const;
}
