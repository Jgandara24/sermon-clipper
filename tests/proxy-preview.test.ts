import type { PrismaClient } from "@prisma/client";
import { afterEach, expect, it, vi } from "vitest";
import { sourcePreviewUrl } from "@/lib/media/proxy-preview";
import { verifySignedMediaUrl } from "@/lib/media/signed-url";
const findFirst = vi.fn();
const prisma = { derivedMediaArtifact: { findFirst } } as unknown as PrismaClient;
const source = { id: "source", workspaceId: "workspace", storageKey: "workspace/original.mp4" };
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); findFirst.mockReset(); });
it("selects a proxy after original deletion and signs only its registry reference", async () => {
  vi.stubEnv("P4_SERMON_PREPARATION_ENABLED", "true");
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T00:00:00Z"));
  findFirst.mockResolvedValue({ id: "artifact", expiresAt: new Date("2026-10-16T00:00:30Z") });
  const url = await sourcePreviewUrl(prisma, { ...source, storageKey: null });
  expect(url).toMatch(/^\/api\/media\/artifact\?/);
  const signed = verifySignedMediaUrl(new URL(url!, "http://localhost").searchParams);
  expect(signed).toMatchObject({ ok: true, key: "workspace/artifact-preview/artifact", workspaceId: "workspace",
    expiresAt: Math.floor(Date.now() / 1000) + 30 });
  expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
    sourceVideoId: "source", sourceVideo: { workspaceId: "workspace" }, startMs: BigInt(0), kind: "SOURCE_PROXY",
    deletedAt: null, publicationState: "READY",
  }) }));
});
it("does not silently use the original when an enabled proxy is unavailable", async () => {
  vi.stubEnv("P4_SERMON_PREPARATION_ENABLED", "true");
  findFirst.mockResolvedValue(null);
  expect(await sourcePreviewUrl(prisma, source)).toBeNull();
});
it("keeps existing original playback when preparation is disabled", async () => {
  vi.stubEnv("P4_SERMON_PREPARATION_ENABLED", "false");
  expect(await sourcePreviewUrl(prisma, source)).toMatch(/^\/api\/media\/signed\?/);
  expect(findFirst).not.toHaveBeenCalled();
});
