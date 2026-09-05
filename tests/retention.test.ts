import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupIdempotencyKey,
  exportFileGraceCutoff,
  exportFileRetentionGraceMs,
  purgeAbandonedUploads,
  shouldPurgeSourceMedia,
} from "@/lib/retention";

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  delete process.env.EXPORT_FILE_RETENTION_GRACE_MS;
});

describe("exportFileRetentionGraceMs", () => {
  it("defaults to 30 days", () => {
    expect(exportFileRetentionGraceMs()).toBe(30 * DAY_MS);
  });

  it("honors the env override", () => {
    process.env.EXPORT_FILE_RETENTION_GRACE_MS = String(7 * DAY_MS);
    expect(exportFileRetentionGraceMs()).toBe(7 * DAY_MS);
  });

  it("falls back to the default on invalid or negative values", () => {
    process.env.EXPORT_FILE_RETENTION_GRACE_MS = "not-a-number";
    expect(exportFileRetentionGraceMs()).toBe(30 * DAY_MS);
    process.env.EXPORT_FILE_RETENTION_GRACE_MS = "-1000";
    expect(exportFileRetentionGraceMs()).toBe(30 * DAY_MS);
  });
});

describe("exportFileGraceCutoff", () => {
  it("subtracts the grace period from now", () => {
    process.env.EXPORT_FILE_RETENTION_GRACE_MS = String(2 * DAY_MS);
    const now = new Date("2026-07-16T12:00:00.000Z");
    expect(exportFileGraceCutoff(now).toISOString()).toBe("2026-07-14T12:00:00.000Z");
  });
});

describe("cleanupIdempotencyKey", () => {
  it("buckets by UTC day so a project can be re-swept on a later day", () => {
    const projectId = "5d9a1e6e-0000-0000-0000-000000000000";
    const morning = new Date("2026-07-16T00:10:00.000Z");
    const evening = new Date("2026-07-16T23:50:00.000Z");
    const nextDay = new Date("2026-07-17T00:10:00.000Z");

    expect(cleanupIdempotencyKey(projectId, morning)).toBe(`cleanup:${projectId}:2026-07-16`);
    expect(cleanupIdempotencyKey(projectId, morning)).toBe(cleanupIdempotencyKey(projectId, evening));
    expect(cleanupIdempotencyKey(projectId, nextDay)).not.toBe(cleanupIdempotencyKey(projectId, morning));
  });
});

describe("shouldPurgeSourceMedia", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const past = new Date(now.getTime() - DAY_MS);
  const future = new Date(now.getTime() + DAY_MS);

  it("purges when every referencing project has expired", () => {
    expect(shouldPurgeSourceMedia([{ expiresAt: past }, { expiresAt: past }], now)).toBe(true);
  });

  it("treats an expiry exactly at now as expired", () => {
    expect(shouldPurgeSourceMedia([{ expiresAt: now }], now)).toBe(true);
  });

  it("never purges while any referencing project is still active", () => {
    expect(shouldPurgeSourceMedia([{ expiresAt: past }, { expiresAt: null }], now)).toBe(false);
    expect(shouldPurgeSourceMedia([{ expiresAt: past }, { expiresAt: future }], now)).toBe(false);
  });

  it("never purges media that no project references", () => {
    expect(shouldPurgeSourceMedia([], now)).toBe(false);
  });
});

describe("purgeAbandonedUploads", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "upload-sweep-"));
    process.env.STORAGE_LOCAL_ROOT = root;
    delete process.env.STORAGE_PROVIDER;
  });

  afterEach(async () => {
    delete process.env.STORAGE_LOCAL_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  async function writeTemp(key: string, ageMs: number) {
    const full = path.join(root, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "x");
    const when = new Date(Date.now() - ageMs);
    await utimes(full, when, when);
    return key;
  }

  it("removes an unfinished upload older than a day", async () => {
    const key = await writeTemp("tmp/ws-1/abandoned", 2 * DAY_MS);
    const result = await purgeAbandonedUploads();
    expect(result.removed).toEqual([key]);
    await expect(access(path.join(root, key))).rejects.toThrow();
  });

  it("leaves an upload that is still in progress alone", async () => {
    const key = await writeTemp("tmp/ws-1/in-flight", 60_000);
    const result = await purgeAbandonedUploads();
    expect(result.removed).toEqual([]);
    await expect(access(path.join(root, key))).resolves.toBeUndefined();
  });

  // The sweep is by prefix because these objects have no database row to scan from. It must not
  // wander outside tmp/ — everything else is referenced by a column and purged by project.
  it("never touches anything outside the tmp prefix", async () => {
    await writeTemp("src/ws-1/real-source.mp4", 400 * DAY_MS);
    await writeTemp("audio/ws-1/real-audio.wav", 400 * DAY_MS);
    const result = await purgeAbandonedUploads();
    expect(result.removed).toEqual([]);
    await expect(access(path.join(root, "src/ws-1/real-source.mp4"))).resolves.toBeUndefined();
  });

  it("reports nothing when no upload has ever been started", async () => {
    await expect(purgeAbandonedUploads()).resolves.toEqual({ scanned: 0, removed: [] });
  });
});
