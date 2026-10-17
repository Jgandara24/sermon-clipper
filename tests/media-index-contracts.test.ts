import { describe, expect, it } from "vitest";
import {
  artifactIdentityKey, artifactRecordSchema, artifactTimeToSource, sourceTimeToArtifact,
  sourceTimeMappingSchema, type ArtifactIdentity,
} from "@/lib/media-artifacts/types";
import { mediaRegionIdentityKey, mediaRegionSchema, type MediaRegionFact } from "@/lib/media-regions/types";

const identity: ArtifactIdentity = {
  sourceVideoId: "00000000-0000-4000-8000-000000000001",
  sourceSha256: "a".repeat(64), kind: "CANDIDATE_RANGE", derivationVersion: "test-v1",
  configurationSha256: "b".repeat(64), sourceInterval: { startMs: 1000, endMs: 4000 },
};
const record = {
  ...identity, storageKey: "fixtures/range.mp4", sha256: "c".repeat(64), byteCount: BigInt(500),
  retentionClass: "RENDER_SOURCE", expiresAt: null, mappingStatus: "DECLARED",
  mappingEvidenceSha256: null, visualQuality: "NOT_REVIEWED",
};
const region: MediaRegionFact = {
  sourceVideoId: identity.sourceVideoId, sourceSha256: identity.sourceSha256,
  sourceInterval: identity.sourceInterval, kind: "FULLSCREEN_SLIDE", detectorVersion: "test-v1",
  configurationSha256: "b".repeat(64), evidenceSha256: "c".repeat(64), inputSha256: "d".repeat(64),
  confidence: 0.8, slideSubtype: "SCRIPTURE", ocrEvidence: "Test text",
};

describe("source-owned media identities", () => {
  it("keeps identity independent of object field order", () => {
    expect(artifactIdentityKey({ ...identity, sourceInterval: { endMs: 4000, startMs: 1000 } }))
      .toBe(artifactIdentityKey(identity));
  });
  it.each([
    { sourceVideoId: "00000000-0000-4000-8000-000000000002" },
    { sourceSha256: "e".repeat(64) }, { configurationSha256: "e".repeat(64) },
    { derivationVersion: "test-v2" }, { kind: "SOURCE_PROXY" as const },
    { sourceInterval: { startMs: 2000, endMs: 4000 } },
  ])("separates changed artifact inputs: %j", change => {
    expect(artifactIdentityKey({ ...identity, ...change })).not.toBe(artifactIdentityKey(identity));
  });
  it("rejects project ownership and missing byte identity", () => {
    expect(artifactRecordSchema.safeParse({ ...record, projectId: "project" }).success).toBe(false);
    expect(artifactRecordSchema.safeParse({ ...record, sourceSha256: "" }).success).toBe(false);
  });
  it("does not accept an unsupported mapping claim", () => {
    expect(artifactRecordSchema.safeParse(record).success).toBe(true);
    expect(artifactRecordSchema.safeParse({ ...record, mappingStatus: "VERIFIED" }).success).toBe(false);
    expect(artifactRecordSchema.safeParse({ ...record, mappingStatus: "VERIFIED",
      mappingEvidenceSha256: "d".repeat(64) }).success).toBe(true);
  });
  it.each([{ byteCount: BigInt(0) }, { byteCount: BigInt(-1) }, { sha256: "invalid" },
    { retentionClass: "PREVIEW" }, { visualQuality: "NOT_APPLICABLE" },
    { sourceInterval: { startMs: 1000, endMs: 1000 } }])("rejects invalid artifact facts: case %#", change => {
    expect(artifactRecordSchema.safeParse({ ...record, ...change }).success).toBe(false);
  });
});

describe("explicit source-time mapping", () => {
  const mapping = { sourceInterval: { startMs: 600000, endMs: 660000 }, artifactOriginMs: 125, timeScale: "1:1" as const };
  it("maps a nonzero artifact clock and both interval boundaries", () => {
    for (const timestamp of [600000, 600001, 630000, 659999, 660000]) {
      const artifactTime = sourceTimeToArtifact(mapping, timestamp);
      expect(artifactTime).toBe(timestamp - 600000 + 125);
      expect(artifactTimeToSource(mapping, artifactTime)).toBe(timestamp);
    }
  });
  it.each([-1, 124, 60126, NaN, Infinity, 125.5])("rejects invalid artifact time %s", timestamp => {
    expect(() => artifactTimeToSource(mapping, timestamp)).toThrow();
  });
  it.each([599999, 660001, NaN, Infinity])("rejects invalid source time %s", timestamp => {
    expect(() => sourceTimeToArtifact(mapping, timestamp)).toThrow();
  });
  it("rejects overflow without clamping timestamps", () => {
    expect(sourceTimeMappingSchema.safeParse({ ...mapping, artifactOriginMs: Number.MAX_SAFE_INTEGER }).success).toBe(false);
  });
  it("avoids intermediate rounding near the safe integer limit", () => {
    const large = { sourceInterval: { startMs: Number.MAX_SAFE_INTEGER - 1, endMs: Number.MAX_SAFE_INTEGER },
      artifactOriginMs: 1, timeScale: "1:1" as const };
    expect(sourceTimeToArtifact(large, Number.MAX_SAFE_INTEGER)).toBe(2);
    expect(artifactTimeToSource(large, 2)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("source region facts", () => {
  it("retains overlapping facts without adding editorial decisions", () => {
    expect(mediaRegionSchema.safeParse(region).success).toBe(true);
    expect(mediaRegionSchema.safeParse({ ...region, kind: "SERMON", slideSubtype: null }).success).toBe(true);
    expect(mediaRegionSchema.safeParse({ ...region, allowed: true }).success).toBe(false);
  });
  it.each([{ confidence: -0.1 }, { confidence: 1.1 }, { confidence: NaN },
    { slideSubtype: null }, { kind: "SERMON" }, { detectorVersion: " " },
    { sourceInterval: { startMs: 5000, endMs: 1000 } }])("rejects invalid regions: %j", change => {
    expect(mediaRegionSchema.safeParse({ ...region, ...change }).success).toBe(false);
  });
  it("deduplicates identical runs but separates new detector and transcript inputs", () => {
    expect(mediaRegionIdentityKey({ ...region })).toBe(mediaRegionIdentityKey(region));
    for (const change of [{ detectorVersion: "test-v2" }, { inputSha256: "e".repeat(64) },
      { configurationSha256: "f".repeat(64) }, { slideSubtype: "MAIN_POINT" as const }]) {
      expect(mediaRegionIdentityKey({ ...region, ...change })).not.toBe(mediaRegionIdentityKey(region));
    }
  });
});
