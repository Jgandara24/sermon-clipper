import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { deriveVerseSlideshows, slideGroupInputSchema } from "./slide-groups";
import type { z } from "zod";
import { recordLateRegionExceptions } from "./publication-exceptions";
import type { Prisma, PrismaClient } from "@prisma/client";
import { lockMediaSource } from "@/lib/media-artifacts/persistence";
import { mediaRegionIdentityKey, mediaRegionSchema, type MediaRegionFact } from "./types";

export async function recordMediaRegion(prisma: PrismaClient, workspaceId: string, input: MediaRegionFact) {
  const record = mediaRegionSchema.parse(input);
  return prisma.$transaction(async tx => {
    await lockMediaSource(tx, workspaceId, record.sourceVideoId);
    return persistRegion(tx, workspaceId, record);
  });
}

async function persistRegion(tx: Prisma.TransactionClient, workspaceId: string, record: MediaRegionFact,
  derivationEvidence?: Prisma.InputJsonObject) {
  const { sourceInterval, ...facts } = record;
  const identityKey = mediaRegionIdentityKey(record);
  if (derivationEvidence && rangeEvidenceSha256(derivationEvidence) !== record.evidenceSha256) throw new Error("MEDIA_REGION_EVIDENCE_MISMATCH");
  const existing = await tx.mediaRegion.findUnique({ where: { identityKey } });
  if (existing) {
    if (existing.confidence !== record.confidence || existing.evidenceSha256 !== record.evidenceSha256 ||
        existing.ocrEvidence !== record.ocrEvidence ||
        rangeEvidenceSha256(existing.derivationEvidence) !== rangeEvidenceSha256(derivationEvidence ?? null)) {
      throw new Error("MEDIA_REGION_IDENTITY_CONFLICT");
    }
    await recordLateRegionExceptions(tx, workspaceId, existing);
    return existing;
  }
  const created = await tx.mediaRegion.create({ data: {
    ...facts, identityKey, ...(derivationEvidence ? { derivationEvidence } : {}), startMs: BigInt(sourceInterval.startMs), endMs: BigInt(sourceInterval.endMs),
  } });
  await recordLateRegionExceptions(tx, workspaceId, created);
  return created;
}

/** Persist input slides and derived groups together under the source lock. Never modify earlier detector facts. */
export async function recordSlideRegionBatch(prisma: PrismaClient, workspaceId: string, value: z.infer<typeof slideGroupInputSchema>) {
  const input = slideGroupInputSchema.parse(value);
  const groups = deriveVerseSlideshows(input);
  return prisma.$transaction(async tx => {
    await lockMediaSource(tx, workspaceId, input.sourceVideoId);
    const slides = [];
    for (const slide of input.slides) slides.push(await persistRegion(tx, workspaceId, slide));
    const recordedGroups = [];
    for (const group of groups) recordedGroups.push(await persistRegion(tx, workspaceId, group.fact, group.evidence));
    return { slides, groups: recordedGroups };
  });
}
