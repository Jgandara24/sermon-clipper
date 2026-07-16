import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupIdempotencyKey,
  exportFileGraceCutoff,
  exportFileRetentionGraceMs,
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
