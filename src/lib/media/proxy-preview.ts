import type { PrismaClient } from "@prisma/client";
import { createSignedMediaUrl, DEFAULT_MEDIA_URL_TTL_SECONDS } from "./signed-url";
import { sermonPreparationEnabled } from "./preparation-config";

/** Call only after authorizing access to the project or source. Playback checks ownership again. */
export async function sourcePreviewUrl(prisma: PrismaClient, source: {
  id: string; workspaceId: string; storageKey: string | null;
} | null): Promise<string | null> {
  if (!source) return null;
  if (!sermonPreparationEnabled()) return source.storageKey ? createSignedMediaUrl({
    key: source.storageKey, workspaceId: source.workspaceId, contentType: "video/mp4",
  }) : null;
  const now = new Date();
  const artifact = await prisma.derivedMediaArtifact.findFirst({ where: {
    sourceVideoId: source.id, sourceVideo: { workspaceId: source.workspaceId }, kind: "SOURCE_PROXY",
    derivationVersion: "analysis-audio-proxy-v2", startMs: BigInt(0), publicationState: "READY", deletedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
  if (!artifact) return null;
  return artifactPreviewUrl(artifact, source.workspaceId, "video/mp4", now);
}

/** The caller must authorize the registry row before minting this logical reference. */
export function artifactPreviewUrl(artifact: { id: string; expiresAt: Date | null }, workspaceId: string,
  contentType: "video/mp4" | "image/webp", now = new Date()): string | null {
  const seconds = Math.min(DEFAULT_MEDIA_URL_TTL_SECONDS,
    artifact.expiresAt ? Math.floor((artifact.expiresAt.getTime() - now.getTime()) / 1000) : DEFAULT_MEDIA_URL_TTL_SECONDS);
  if (seconds < 1) return null;
  return createSignedMediaUrl({ key: `${workspaceId}/artifact-preview/${artifact.id}`,
    workspaceId, contentType, expiresInSeconds: seconds,
  }).replace("/api/media/signed?", "/api/media/artifact?");
}
