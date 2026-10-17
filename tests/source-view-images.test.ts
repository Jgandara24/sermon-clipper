import type { PrismaClient } from "@prisma/client";
import { afterEach, expect, it, vi } from "vitest";
import { sourceViewImages } from "@/lib/media/source-view-images";
const findMany = vi.fn();
const prisma = { derivedMediaArtifact: { findMany } } as unknown as PrismaClient;
const source = { id: "source", workspaceId: "workspace" };
afterEach(() => { vi.unstubAllEnvs(); findMany.mockReset(); });
const artifact = () => ({ id: "artifact", kind: "TIMELINE_VIEW", expiresAt: null, startMs: BigInt(1000), endMs: BigInt(2001),
  publicationEvidence: { derivation: { version: "proxy-contact-sheet-v2", kind: "TIMELINE_VIEW", width: 200, height: 100,
    coverage: "sampled-instants-only", confidence: 0.99, cells: [{ index: 0, sourceTimeMs: 1000 }, { index: 1, sourceTimeMs: 2000 }] } } });
it("returns only image geometry and source times after ownership filtering", async () => {
  vi.stubEnv("P4_SERMON_PREPARATION_ENABLED", "true");
  findMany.mockResolvedValue([artifact()]);
  const images = await sourceViewImages(prisma, source);
  expect(images).toEqual([{ id: "artifact", kind: "TIMELINE_VIEW", width: 200, height: 100,
    sourceTimesMs: [1000, 2000], url: expect.stringContaining("/api/media/artifact?") }]);
  expect(JSON.stringify(images)).not.toContain("confidence");
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
    sourceVideoId: "source", sourceVideo: { workspaceId: "workspace" }, deletedAt: null, publicationState: "READY",
  }), take: 8 }));
});
it("omits invalid cell maps and mismatched kinds", async () => {
  vi.stubEnv("P4_SERMON_PREPARATION_ENABLED", "true");
  const badOrder = artifact(); badOrder.publicationEvidence.derivation.cells.reverse();
  const outside = artifact(); outside.publicationEvidence.derivation.cells[0].sourceTimeMs = 0;
  const mismatch = artifact(); mismatch.kind = "BOUNDARY_STRIP";
  findMany.mockResolvedValue([badOrder, outside, mismatch]);
  expect(await sourceViewImages(prisma, source)).toEqual([]);
});
it("does not query images while preparation is disabled", async () => {
  vi.stubEnv("P4_SERMON_PREPARATION_ENABLED", "false");
  expect(await sourceViewImages(prisma, source)).toEqual([]);
  expect(findMany).not.toHaveBeenCalled();
});
