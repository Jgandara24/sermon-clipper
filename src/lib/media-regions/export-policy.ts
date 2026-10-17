import { regionBlocksVideo } from "./video-policy";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { sha256Schema, sourceIntervalSchema } from "@/lib/media-artifacts/types";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { ExportFailureError } from "@/lib/exports/errors";

const inputSchema = z.object({ workspaceId: z.string().uuid(), sourceVideoId: z.string().uuid(),
  sourceSha256: sha256Schema, sourceInterval: sourceIntervalSchema }).strict();
type Client = Pick<PrismaClient, "mediaRegion" | "sourceVideo"> | Prisma.TransactionClient;

/** Refuse known unsafe content. Absence of facts is not evidence of complete detector coverage. */
export async function assertRegionExportAllowed(client: Client, value: z.infer<typeof inputSchema>) {
  return checkRegions(client, inputSchema.parse(value));
}

/** Original exports have no pinned checksum. Check every retained identity conservatively. */
export async function assertOriginalRegionExportAllowed(client: Client, value: z.infer<typeof originalInputSchema>) {
  return checkRegions(client, { ...originalInputSchema.parse(value), sourceSha256: null });
}
const originalInputSchema = inputSchema.omit({ sourceSha256: true });

async function checkRegions(client: Client, input: z.infer<typeof originalInputSchema> & { sourceSha256: string | null }) {
  const source = await client.sourceVideo.findFirst({ where: { id: input.sourceVideoId, workspaceId: input.workspaceId }, select: { id: true } });
  if (!source) throw new ExportFailureError("EXPORT_REGION_SOURCE_MISMATCH", "The source evidence does not match this workspace.", { terminal: true });
  const regions = await client.mediaRegion.findMany({ where: { sourceVideoId: source.id, ...(input.sourceSha256 ? { sourceSha256: input.sourceSha256 } : {}),
    startMs: { lt: BigInt(input.sourceInterval.endMs) }, endMs: { gt: BigInt(input.sourceInterval.startMs) } },
    orderBy: { id: "asc" }, select: { id: true, identityKey: true, kind: true, evidenceSha256: true, sourceSha256: true } });
  // Unknown kinds also stop export. New region types require an explicit policy decision.
  if (regions.some(region => regionBlocksVideo(region.kind))) {
    throw new ExportFailureError("EXPORT_FORBIDDEN_REGION", "This clip overlaps restricted source content. Review its boundaries before export.", { terminal: true });
  }
  return { version: "known-region-export-policy-v1", result: "NO_KNOWN_FORBIDDEN_OVERLAP",
    coverage: "not_proven", identityScope: input.sourceSha256 ? "exact_checksum" : "all_retained_source_identities", inputSha256: rangeEvidenceSha256({ ...input, regions }), regionCount: regions.length };
}
