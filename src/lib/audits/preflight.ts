import type { PrismaClient } from "@prisma/client";

type WorkspaceFilter = { workspaceId?: string };

/** Censuses duplicate workspace/date rows before Wave 1 adds active-date uniqueness. */
export async function auditScheduledPostCollisions(
  client: PrismaClient,
  filter: WorkspaceFilter = {},
) {
  const rows = await client.scheduledPost.findMany({
    where: filter.workspaceId ? { workspaceId: filter.workspaceId } : undefined,
    orderBy: [{ workspaceId: "asc" }, { scheduledDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      workspaceId: true,
      scheduledDate: true,
      publishStatus: true,
      createdAt: true,
      clip: { select: { projectId: true } },
    },
  });

  const byWorkspaceDate = new Map<string, typeof rows>();
  for (const row of rows) {
    const date = row.scheduledDate.toISOString().slice(0, 10);
    const key = `${row.workspaceId}:${date}`;
    const group = byWorkspaceDate.get(key) ?? [];
    group.push(row);
    byWorkspaceDate.set(key, group);
  }

  const collisions = [...byWorkspaceDate.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      workspaceId: group[0].workspaceId,
      scheduledDate: group[0].scheduledDate.toISOString().slice(0, 10),
      rowCount: group.length,
      rows: group.map((row, index) => ({
        scheduledPostId: row.id,
        projectId: row.clip?.projectId ?? null,
        publishStatus: row.publishStatus,
        createdAt: row.createdAt.toISOString(),
        disposition: index === 0 ? "earlier_row_keeps_date" : "later_row_collision",
      })),
    }));

  return {
    scannedRowCount: rows.length,
    duplicateDateCount: collisions.length,
    duplicateRowCount: collisions.reduce((sum, collision) => sum + collision.rowCount, 0),
    extraRowCount: collisions.reduce((sum, collision) => sum + collision.rowCount - 1, 0),
    collisions,
  };
}

/**
 * Censuses rows that cannot prove an exact editor version before ExportJob.editVersion exists.
 * P1.2 adds that binding. Every current SUCCEEDED export is therefore a legacy export.
 */
export async function auditLegacyExports(client: PrismaClient, filter: WorkspaceFilter = {}) {
  const workspaceWhere = filter.workspaceId ? { workspaceId: filter.workspaceId } : {};
  const legacyExports = await client.exportJob.findMany({
    where: { ...workspaceWhere, state: "SUCCEEDED" },
    select: { id: true, clipId: true, workspaceId: true, outputFileId: true },
    orderBy: { createdAt: "asc" },
  });

  const armedPosts = await client.scheduledPost.findMany({
    where: {
      ...workspaceWhere,
      publishStatus: { in: ["NOT_STARTED", "IN_PROGRESS"] },
      clipId: { not: null },
    },
    select: {
      id: true,
      clip: {
        select: {
          exportJobs: {
            where: { state: "SUCCEEDED", outputFileId: { not: null } },
            select: { id: true },
          },
        },
      },
    },
  });
  const armedBackedByLegacy = armedPosts.filter(
    (post) => (post.clip?.exportJobs.length ?? 0) > 0,
  );

  const demotedApprovals = await client.clipApproval.findMany({
    where: {
      ...workspaceWhere,
      state: "DRAFT",
      auditEvents: {
        some: {
          eventType: "review_link_revoked",
          metadata: { path: ["reason"], equals: "clip_edited_after_approval" },
        },
      },
      clip: {
        exportJobs: { some: { state: "SUCCEEDED", outputFileId: { not: null } } },
      },
    },
    select: { clipId: true },
    orderBy: { createdAt: "asc" },
  });

  return {
    succeededExportsWithoutProvableEditVersion: legacyExports.length,
    legacyExportJobIds: legacyExports.map((job) => job.id),
    armedScheduledPostsBackedOnlyByLegacyExports: armedBackedByLegacy.length,
    armedScheduledPostIds: armedBackedByLegacy.map((post) => post.id),
    clipsWithDemotedApprovalsAndPublishableExports: demotedApprovals.length,
    demotedApprovalClipIds: demotedApprovals.map((approval) => approval.clipId),
  };
}
