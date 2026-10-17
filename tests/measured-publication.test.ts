import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalDiskStorageProvider } from "@/lib/storage/local-disk-provider";
import { measurePublicationStorage } from "@/lib/storage/measured-publication";
import { StorageDownloadError, type StorageProvider } from "@/lib/storage/types";
import type { ProcessingCostFactInput } from "@/lib/cost/types";

let root: string;
let source: string;
let local: StorageProvider;
let facts: ProcessingCostFactInput[];
const settings = { provider: "s3" as const, downloadPricePerGbUsd: 0.09, uploadPricePerGbUsd: 0.01, attempt: 2 };
const record = async (fact: ProcessingCostFactInput) => { facts.push(fact); };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "measured-publication-"));
  source = path.join(root, "source");
  await writeFile(source, "hello");
  local = new LocalDiskStorageProvider(path.join(root, "storage"));
  facts = [];
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("records conditional upload and identity-pinned verification download without changing identities", async () => {
  const storage = measurePublicationStorage(local, settings, record);
  expect(storage.getStorageIdentity!()).toBe(local.getStorageIdentity!());
  await storage.uploadFileIfAbsent!("artifact", source);
  const identity = await storage.getObjectIdentity!("artifact");
  await storage.downloadToFile("artifact", path.join(root, "copy"), identity!);
  expect(facts).toEqual([
    expect.objectContaining({ stage: "upload", bytes: 5, quantity: 5e-9, unitCostUsd: 0.01, attempt: 2, outcome: "succeeded" }),
    expect.objectContaining({ stage: "download", bytes: 5, quantity: 5e-9, unitCostUsd: 0.09, attempt: 2, outcome: "succeeded" }),
  ]);
});

it("keeps unknown failed upload bytes unpriced and preserves the original error", async () => {
  await local.uploadFileIfAbsent!("artifact", source);
  const storage = measurePublicationStorage(local, settings, record);
  await expect(storage.uploadFileIfAbsent!("artifact", source)).rejects.toThrow();
  expect(facts).toEqual([expect.objectContaining({ outcome: "failed", bytes: null, quantity: 0,
    unitCostUsd: null, details: { operation: "uploadFileIfAbsent", transferBytesKnown: false } })]);
});

it("uses provider transfer counts for cache hits and partial failures", async () => {
  const storage = measurePublicationStorage(local, settings, record);
  vi.spyOn(local, "downloadToFile").mockResolvedValueOnce({ transferredBytes: 0, cacheState: "hit" });
  await storage.downloadToFile("cached", path.join(root, "not-needed"));
  const error = new StorageDownloadError(new Error("interrupted"), { transferredBytes: 3, cacheState: "miss" });
  vi.mocked(local.downloadToFile).mockRejectedValueOnce(error);
  await expect(storage.downloadToFile("failed", path.join(root, "partial"))).rejects.toBe(error);
  expect(facts[0]).toMatchObject({ bytes: 0, quantity: 0, cacheState: "hit", outcome: "succeeded" });
  expect(facts[1]).toMatchObject({ bytes: 3, quantity: 3e-9, cacheState: "miss", outcome: "failed" });
});

it("keeps failed downloads without transfer evidence unknown", async () => {
  const storage = measurePublicationStorage(local, settings, record);
  await expect(storage.downloadToFile("missing", path.join(root, "missing"))).rejects.toThrow();
  expect(facts[0]).toMatchObject({ bytes: null, unitCostUsd: null, outcome: "failed" });
});
