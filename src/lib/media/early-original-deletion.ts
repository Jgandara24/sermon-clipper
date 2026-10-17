import type { Prisma, PrismaClient } from "@prisma/client";
import { DEFAULT_EDIT_VERSION, loadPinnedEditorState } from "@/lib/exports/edit-version";
import { rangeExportsEnabled } from "@/lib/exports/range-policy";
import { recordOperationalEvent } from "@/lib/observability/operational-events";
import { lockSourceVideoForRetention, removeStorageObjectIfExists, sourceRetentionDeletionEnabled } from "@/lib/retention";
import { rangeEvidenceSha256 } from "./range-evidence";
import { sermonPreparationEnabled } from "./preparation-config";

export const EARLY_ORIGINAL_DELETION_PROOF_VERSION = "early-original-deletion-proof-v1";
const UNFINISHED = ["QUEUED", "WAITING", "RETRYING", "RUNNING"] as const;
const PROXY_DERIVATION_VERSION = "analysis-audio-proxy-v2";

/** Separate controlled activation. The 14-day retention date remains the fallback in every other case. */
export function earlyOriginalDeletionEnabled(): boolean {
  return process.env.P4_EARLY_ORIGINAL_DELETION_ENABLED === "true";
}

export type EarlyDeletionCandidateProof = {
  clipId: string; editVersion: number; startMs: number; endMs: number;
  artifactId: string; artifactSha256: string; reviewId: string; mappingEvidenceSha256: string;
};
export type EarlyDeletionProof = {
  version: typeof EARLY_ORIGINAL_DELETION_PROOF_VERSION; sourceVideoId: string; storageKey: string;
  sourceSha256: string; fallbackDate: string; proxyArtifactId: string; candidates: EarlyDeletionCandidateProof[];
};
export type EarlyDeletionAssessment =
  | { eligible: true; proof: EarlyDeletionProof; proofSha256: string }
  | { eligible: false; reason: string; detail?: Record<string, string | number | null> };

const refuse = (reason: string, detail?: Record<string, string | number | null>): EarlyDeletionAssessment =>
  ({ eligible: false, reason, ...(detail ? { detail } : {}) });

/** An artifact must outlive the date the original would otherwise have been kept. */
function outlives(expiresAt: Date | null, fallbackDate: Date) {
  return expiresAt === null || expiresAt.getTime() >= fallbackDate.getTime();
}

/**
 * Reads every fact the deletion depends on. The caller must hold the source retention lock, the
 * cleanup gate share lock, and the project, clip, and artifact row locks taken by `attemptEarlyOriginalDeletion`.
 */
export async function assessEarlyOriginalDeletion(tx: Prisma.TransactionClient,
  input: { sourceVideoId: string; now: Date; excludeProcessingJobId?: string }): Promise<EarlyDeletionAssessment> {
  if (!earlyOriginalDeletionEnabled()) return refuse("early_deletion_disabled");
  // Without active range exports and proxy playback, exports and previews still read the original.
  if (!rangeExportsEnabled()) return refuse("range_exports_disabled");
  if (!sermonPreparationEnabled()) return refuse("proxy_playback_disabled");
  const source = await tx.sourceVideo.findUnique({ where: { id: input.sourceVideoId } });
  if (!source?.storageKey) return refuse("original_absent");
  const projects = await tx.project.findMany({ where: { sourceVideoId: source.id }, select: { id: true, expiresAt: true } });
  if (projects.length === 0) return refuse("no_project");
  if (projects.some(project => project.expiresAt === null)) return refuse("project_without_retention_date");
  const fallbackDate = new Date(Math.max(...projects.map(project => project.expiresAt!.getTime())));
  // At or after the fallback date, the ordinary retention reaper owns deletion.
  if (fallbackDate.getTime() <= input.now.getTime()) return refuse("fallback_date_reached");
  const projectIds = projects.map(project => project.id);

  const processing = await tx.processingJob.findFirst({ where: { projectId: { in: projectIds },
    state: { in: [...UNFINISHED] }, ...(input.excludeProcessingJobId ? { id: { not: input.excludeProcessingJobId } } : {}) },
    select: { id: true, type: true } });
  if (processing) return refuse("unfinished_processing_job", { jobId: processing.id, type: processing.type });
  const exportJob = await tx.exportJob.findFirst({ where: { clip: { projectId: { in: projectIds } }, state: { in: [...UNFINISHED] } },
    select: { id: true } });
  if (exportJob) return refuse("unfinished_export", { exportJobId: exportJob.id });
  const fallback = await tx.exportFullSourceFallback.findFirst({ where: { sourceVideoId: source.id,
    editorialException: { state: "OPEN" } }, select: { id: true } });
  if (fallback) return refuse("open_full_source_fallback", { fullSourceFallbackId: fallback.id });

  const clips = await tx.generatedClip.findMany({ where: { projectId: { in: projectIds }, OR: [
    { status: { not: "SUPERSEDED" } },
    // A bound clip can still need a render even after supersession, until its slot is final.
    { scheduledPosts: { some: { publishStatus: { notIn: ["SUCCEEDED", "MISSED"] } } } },
  ] }, orderBy: { id: "asc" } });
  if (clips.length === 0) return refuse("no_retained_candidate");

  const ranges = await tx.derivedMediaArtifact.findMany({ where: { sourceVideoId: source.id, kind: "CANDIDATE_RANGE",
    publicationState: "READY", mappingStatus: "VERIFIED", visualQuality: "ACCEPTED", retentionClass: "RENDER_SOURCE",
    deletedAt: null, mappingEvidenceSha256: { not: null } }, orderBy: [{ byteCount: "asc" }, { id: "asc" }],
  include: { reviews: { orderBy: { revision: "desc" }, take: 1 } } });
  // Only the latest review counts; a later rejection withdraws an earlier acceptance.
  const approved = ranges.filter(range => {
    const review = range.reviews[0];
    return review && review.decision === "ACCEPTED" && review.artifactSha256 === range.sha256 &&
      review.sourceSha256 === range.sourceSha256 && review.mappingEvidenceSha256 === range.mappingEvidenceSha256 &&
      outlives(range.expiresAt, fallbackDate);
  });

  const candidates: EarlyDeletionCandidateProof[] = [];
  for (const clip of clips) {
    const latest = await tx.clipEdit.findFirst({ where: { clipId: clip.id }, orderBy: { version: "desc" }, select: { version: true } });
    const editVersion = latest?.version ?? DEFAULT_EDIT_VERSION;
    const state = await loadPinnedEditorState(tx, { clipId: clip.id, editVersion,
      defaults: { sourceVideoId: source.id, startMs: clip.startMs, endMs: clip.endMs } });
    if (state.source.videoId !== source.id) return refuse("candidate_source_changed", { clipId: clip.id });
    const covering = approved.find(range => range.startMs <= BigInt(state.source.startMs) && range.endMs >= BigInt(state.source.endMs));
    if (!covering) return refuse("candidate_range_missing", { clipId: clip.id, editVersion,
      startMs: state.source.startMs, endMs: state.source.endMs });
    candidates.push({ clipId: clip.id, editVersion, startMs: state.source.startMs, endMs: state.source.endMs,
      artifactId: covering.id, artifactSha256: covering.sha256, reviewId: covering.reviews[0].id,
      mappingEvidenceSha256: covering.mappingEvidenceSha256! });
  }
  const sourceShas = new Set(candidates.map(candidate => approved.find(range => range.id === candidate.artifactId)!.sourceSha256));
  if (sourceShas.size !== 1) return refuse("candidate_ranges_disagree_on_source_bytes");
  const [sourceSha256] = [...sourceShas];

  const proxy = await tx.derivedMediaArtifact.findFirst({ where: { sourceVideoId: source.id, kind: "SOURCE_PROXY",
    derivationVersion: PROXY_DERIVATION_VERSION, startMs: BigInt(0), publicationState: "READY", deletedAt: null, sourceSha256 },
  orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
  if (!proxy || !outlives(proxy.expiresAt, fallbackDate)) return refuse("proxy_missing");

  const proof: EarlyDeletionProof = { version: EARLY_ORIGINAL_DELETION_PROOF_VERSION, sourceVideoId: source.id,
    storageKey: source.storageKey, sourceSha256, fallbackDate: fallbackDate.toISOString(), proxyArtifactId: proxy.id, candidates };
  return { eligible: true, proof, proofSha256: rangeEvidenceSha256(proof) };
}

export type EarlyDeletionOutcome =
  | { status: "DELETED" | "REPORT_ONLY"; proofSha256: string; candidateCount: number; storageKey: string }
  | { status: "REFUSED"; reason: string; detail?: Record<string, string | number | null> };

/**
 * Deletes only the large original. Audio, thumbnails, overrides, artifacts, and records remain.
 * Every input to the decision is locked until the key is cleared and the proof event commits.
 */
export async function attemptEarlyOriginalDeletion(prisma: PrismaClient,
  input: { workspaceId: string; sourceVideoId: string; now?: Date; processingJobId?: string; projectId?: string }): Promise<EarlyDeletionOutcome> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async tx => {
    // Range and fallback producers, retention extensions, and the reaper take this same row lock.
    if (!(await lockSourceVideoForRetention(tx, input.sourceVideoId))) return { status: "REFUSED", reason: "source_missing" };
    const owner = await tx.sourceVideo.findUniqueOrThrow({ where: { id: input.sourceVideoId }, select: { workspaceId: true } });
    if (owner.workspaceId !== input.workspaceId) return { status: "REFUSED", reason: "workspace_mismatch" };
    const [gate] = await tx.$queryRaw<Array<{ state: string }>>`
      SELECT state FROM source_media_gates WHERE source_id = ${input.sourceVideoId}::uuid FOR SHARE`;
    if (gate && gate.state !== "ACTIVE") return { status: "REFUSED", reason: "cleanup_gate_not_active" };
    if (await tx.sourceMediaSession.findFirst({ where: { sourceId: input.sourceVideoId, state: { not: "COMPLETE" } }, select: { id: true } })) {
      return { status: "REFUSED", reason: "unfinished_source_session" };
    }
    // FOR UPDATE conflicts with the key-share locks that new clips, edits, export jobs, and reviews take.
    await tx.$queryRaw`SELECT id FROM projects WHERE source_video_id = ${input.sourceVideoId}::uuid ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT c.id FROM generated_clips c JOIN projects p ON p.id = c.project_id
      WHERE p.source_video_id = ${input.sourceVideoId}::uuid ORDER BY c.id FOR UPDATE OF c`;
    await tx.$queryRaw`SELECT id FROM derived_media_artifacts WHERE source_video_id = ${input.sourceVideoId}::uuid
      AND kind IN ('CANDIDATE_RANGE', 'SOURCE_PROXY') ORDER BY id FOR UPDATE`;
    const assessment = await assessEarlyOriginalDeletion(tx, { sourceVideoId: input.sourceVideoId, now,
      excludeProcessingJobId: input.processingJobId });
    if (!assessment.eligible) return { status: "REFUSED", reason: assessment.reason, detail: assessment.detail };
    const { proof, proofSha256 } = assessment;
    const reportOnly = !sourceRetentionDeletionEnabled();
    if (!reportOnly) {
      await removeStorageObjectIfExists(proof.storageKey);
      await tx.sourceVideo.update({ where: { id: input.sourceVideoId }, data: { storageKey: null } });
    }
    // Written in the same transaction: a committed key change always has its proof.
    await recordOperationalEvent(tx, { workspaceId: input.workspaceId, category: "worker",
      eventType: reportOnly ? "early_original_deletion_report_only" : "early_original_deleted", severity: "info",
      message: reportOnly ? "Early original deletion proof passed. Deletion is switched off, so nothing was removed."
        : "The original was deleted early after range coverage proof passed.",
      projectId: input.projectId ?? null, jobId: input.processingJobId ?? null,
      metadata: { proofSha256, proof } as unknown as Prisma.InputJsonValue });
    return { status: reportOnly ? "REPORT_ONLY" : "DELETED", proofSha256, candidateCount: proof.candidates.length,
      storageKey: proof.storageKey };
  }, { timeout: 60000 });
}
