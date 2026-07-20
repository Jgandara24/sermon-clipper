import type { Prisma, PrismaClient } from "@prisma/client";

const MAX_ATTEMPTS = 3;

export class WorkspaceSettingsConflictError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace ${workspaceId} settings kept changing concurrently; giving up after ${MAX_ATTEMPTS} attempts.`);
  }
}

/**
 * Read-modify-write for the workspace settings JSON blob with optimistic concurrency:
 * the write is guarded on the `updatedAt` value observed at read time (bumped by @updatedAt
 * on every workspace write), so two concurrent saves can never silently clobber each other's
 * nested keys — the loser re-reads and reapplies its mutation on the fresh state.
 */
export async function updateWorkspaceSettings(
  client: PrismaClient,
  workspaceId: string,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const workspace = await client.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { settings: true, updatedAt: true },
    });
    const current =
      workspace.settings && typeof workspace.settings === "object" && !Array.isArray(workspace.settings)
        ? (workspace.settings as Record<string, unknown>)
        : {};

    const next = mutate({ ...current });

    const result = await client.workspace.updateMany({
      where: { id: workspaceId, updatedAt: workspace.updatedAt },
      data: { settings: next as Prisma.InputJsonObject },
    });
    if (result.count > 0) {
      return next;
    }
  }

  throw new WorkspaceSettingsConflictError(workspaceId);
}
