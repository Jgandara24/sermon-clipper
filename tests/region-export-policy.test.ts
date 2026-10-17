import type { PrismaClient } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { assertOriginalRegionExportAllowed, assertRegionExportAllowed } from "@/lib/media-regions/export-policy";
const source = vi.fn(), regions = vi.fn();
const client = { sourceVideo: { findFirst: source }, mediaRegion: { findMany: regions } } as unknown as PrismaClient;
const request = { workspaceId: "11111111-1111-4111-8111-111111111111", sourceVideoId: "22222222-2222-4222-8222-222222222222",
  sourceSha256: "a".repeat(64), sourceInterval: { startMs: 1000, endMs: 2000 } };
beforeEach(() => { vi.resetAllMocks(); source.mockResolvedValue({ id: request.sourceVideoId }); regions.mockResolvedValue([]); });
it.each(["FULLSCREEN_SLIDE", "VERSE_SLIDESHOW", "WORSHIP", "ANNOUNCEMENT", "PRAYER", "BAPTISM", "ALTAR_CALL", "OTHER_SERVICE_CONTENT", "AMBIGUOUS", "UNKNOWN"])(
  "blocks known or unknown unsafe region %s", async kind => {
    regions.mockResolvedValue([{ id: "fact", identityKey: "identity", kind, evidenceSha256: "b".repeat(64) }]);
    await expect(assertRegionExportAllowed(client, request)).rejects.toMatchObject({ code: "EXPORT_FORBIDDEN_REGION", terminal: true });
  });
it("checks half-open overlap for the exact source checksum without claiming complete coverage", async () => {
  expect(await assertRegionExportAllowed(client, request)).toMatchObject({ result: "NO_KNOWN_FORBIDDEN_OVERLAP", coverage: "not_proven", regionCount: 0 });
  expect(regions).toHaveBeenCalledWith(expect.objectContaining({ where: {
    sourceVideoId: request.sourceVideoId, sourceSha256: request.sourceSha256, startMs: { lt: BigInt(2000) }, endMs: { gt: BigInt(1000) },
  } }));
});
it("permits sermon and pastor facts while binding their evidence", async () => {
  const empty = await assertRegionExportAllowed(client, request);
  regions.mockResolvedValue([{ id: "fact", identityKey: "identity", kind: "SERMON", evidenceSha256: "b".repeat(64) }]);
  expect((await assertRegionExportAllowed(client, request)).inputSha256).not.toBe(empty.inputSha256);
});
it("rejects workspace mismatches before reading regions", async () => {
  source.mockResolvedValue(null);
  await expect(assertRegionExportAllowed(client, request)).rejects.toMatchObject({ code: "EXPORT_REGION_SOURCE_MISMATCH" });
  expect(regions).not.toHaveBeenCalled();
});

it("checks all retained identities for original exports without claiming checksum proof", async () => {
  const original = { workspaceId: request.workspaceId, sourceVideoId: request.sourceVideoId, sourceInterval: request.sourceInterval };
  expect(await assertOriginalRegionExportAllowed(client, original)).toMatchObject({
    identityScope: "all_retained_source_identities", coverage: "not_proven" });
  expect(regions.mock.calls[0][0].where).not.toHaveProperty("sourceSha256");
  regions.mockResolvedValue([{ id: "fact", kind: "PRAYER", sourceSha256: "c".repeat(64) }]);
  await expect(assertOriginalRegionExportAllowed(client, original)).rejects.toMatchObject({ code: "EXPORT_FORBIDDEN_REGION" });
});
