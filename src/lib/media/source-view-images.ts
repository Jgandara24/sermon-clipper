import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { artifactPreviewUrl } from "./proxy-preview";
import { sermonPreparationEnabled } from "./preparation-config";

const evidenceSchema = z.object({ derivation: z.object({ version: z.literal("proxy-contact-sheet-v2"),
  kind: z.enum(["TIMELINE_VIEW", "BOUNDARY_STRIP"]), width: z.number().int().positive().max(100000),
  height: z.number().int().positive().max(100000), coverage: z.literal("sampled-instants-only"),
  cells: z.array(z.object({ index: z.number().int().nonnegative(), sourceTimeMs: z.number().int().nonnegative().safe() }))
    .min(1).max(64),
}) });
export type SourceViewImage = { id: string; kind: "TIMELINE_VIEW" | "BOUNDARY_STRIP"; url: string;
  width: number; height: number; sourceTimesMs: number[] };

/** Operator caller authorizes source access first. Only image geometry and times cross into the UI. */
export async function sourceViewImages(prisma: PrismaClient, source: { id: string; workspaceId: string } | null): Promise<SourceViewImage[]> {
  if (!source || !sermonPreparationEnabled()) return [];
  const now = new Date();
  const artifacts = await prisma.derivedMediaArtifact.findMany({ where: { sourceVideoId: source.id,
    sourceVideo: { workspaceId: source.workspaceId }, kind: { in: ["TIMELINE_VIEW", "BOUNDARY_STRIP"] },
    derivationVersion: "proxy-contact-sheet-v2", publicationState: "READY", deletedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 8 });
  return artifacts.flatMap(artifact => {
    const parsed = evidenceSchema.safeParse(artifact.publicationEvidence);
    if (!parsed.success || parsed.data.derivation.kind !== artifact.kind) return [];
    const evidence = parsed.data.derivation;
    if (evidence.width * evidence.height > 64000000 || evidence.cells.some((cell, index) =>
      cell.index !== index || (index > 0 && cell.sourceTimeMs <= evidence.cells[index - 1].sourceTimeMs) ||
      BigInt(cell.sourceTimeMs) < artifact.startMs || BigInt(cell.sourceTimeMs) >= artifact.endMs)) return [];
    const url = artifactPreviewUrl(artifact, source.workspaceId, "image/webp", now);
    return url ? [{ id: artifact.id, kind: evidence.kind, url, width: evidence.width, height: evidence.height,
      sourceTimesMs: evidence.cells.map(cell => cell.sourceTimeMs) }] : [];
  });
}
