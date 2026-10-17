import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cache-factory-"));
  vi.resetModules();
  vi.stubEnv("STORAGE_PROVIDER", "local");
  vi.stubEnv("STORAGE_LOCAL_ROOT", path.join(root, "storage"));
  vi.stubEnv("STORAGE_CACHE_ROOT", path.join(root, "cache"));
});
afterEach(async () => {
  const { closeStorageProvider } = await import("@/lib/storage");
  await closeStorageProvider();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("uses the shared factory cache only with explicit capacity", async () => {
  vi.stubEnv("STORAGE_CACHE_MAX_BYTES", "8");
  const { getStorageProvider } = await import("@/lib/storage");
  const storage = getStorageProvider();
  expect(getStorageProvider()).toBe(storage);
  await storage.writeFromWebStream("source", new Blob(["1234"]).stream(), 4);
  expect(await storage.downloadToFile("source", path.join(root, "one"))).toMatchObject({ cacheState: "miss", transferredBytes: 4 });
  expect(await storage.downloadToFile("source", path.join(root, "two"))).toMatchObject({ cacheState: "hit", transferredBytes: 0 });
});

it("keeps zero-capacity storage uncached", async () => {
  vi.stubEnv("STORAGE_CACHE_MAX_BYTES", "0");
  const { getStorageProvider } = await import("@/lib/storage");
  const storage = getStorageProvider();
  expect(storage.constructor.name).toBe("LocalDiskStorageProvider");
});

it("requires a cache directory when capacity enables caching", async () => {
  vi.stubEnv("STORAGE_CACHE_MAX_BYTES", "8");
  vi.stubEnv("STORAGE_CACHE_ROOT", "");
  const { getStorageProvider } = await import("@/lib/storage");
  expect(() => getStorageProvider()).toThrow("STORAGE_CACHE_ROOT");
});
