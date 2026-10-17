import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { registerMediaArtifact } from "@/lib/media-artifacts/persistence";
import { recordMediaRegion, recordSlideRegionBatch } from "@/lib/media-regions/persistence";
import type { ArtifactRecord } from "@/lib/media-artifacts/types";
import type { MediaRegionFact } from "@/lib/media-regions/types";

const prisma = new PrismaClient();
const users: string[] = [];
const workspaces: string[] = [];

async function fixture() {
  const user = await prisma.user.create({ data: { email: `p4-index-${randomUUID()}@example.test`, authProvider: "DEV" } });
  users.push(user.id);
  const workspace = await prisma.workspace.create({ data: { ownerId: user.id, name: "P4 disposable fixture" } });
  workspaces.push(workspace.id);
  const source = await prisma.sourceVideo.create({ data: {
    workspaceId: workspace.id, origin: "UPLOAD", width: 1920, height: 1080, durationS: 60,
  } });
  const project = await prisma.project.create({ data: {
    workspaceId: workspace.id, sourceVideoId: source.id, name: "P4 fixture project", status: "READY",
  } });
  const artifact: ArtifactRecord = {
    sourceVideoId: source.id, sourceSha256: "a".repeat(64), kind: "SOURCE_PROXY",
    derivationVersion: "fixture-v1", configurationSha256: "b".repeat(64),
    sourceInterval: { startMs: 0, endMs: 60000 }, storageKey: `fixture/${randomUUID()}`,
    sha256: "c".repeat(64), byteCount: BigInt(1000), retentionClass: "PREVIEW", expiresAt: null,
    mappingStatus: "DECLARED", mappingEvidenceSha256: null, visualQuality: "NOT_REVIEWED",
  };
  const region: MediaRegionFact = {
    sourceVideoId: source.id, sourceSha256: "a".repeat(64), sourceInterval: { startMs: 1000, endMs: 2000 },
    kind: "FULLSCREEN_SLIDE", detectorVersion: "fixture-v1", configurationSha256: "b".repeat(64),
    evidenceSha256: "c".repeat(64), inputSha256: "d".repeat(64), confidence: 0.8,
    slideSubtype: "SCRIPTURE", ocrEvidence: "Fixture words",
  };
  return { workspace, source, project, artifact, region };
}

afterEach(async () => {
  // No storage objects exist in this suite. This is fixture disposal, not a storage-deletion proof.
  await prisma.derivedMediaArtifact.updateMany({ where: { sourceVideo: { workspaceId: { in: workspaces } }, deletedAt: null },
    data: { deletedAt: new Date(), deletionEvidence: { fixtureOnly: true, noStorageObjectCreated: true } } });
  await prisma.derivedMediaArtifact.deleteMany({ where: { sourceVideo: { workspaceId: { in: workspaces } } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaces.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
afterAll(() => prisma.$disconnect());

describe("Wave 3 source-owned persistence", () => {
  it("deduplicates concurrent artifact registration and keeps original dimensions", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 4 }, () => registerMediaArtifact(prisma, f.workspace.id, f.artifact)));
    expect(new Set(results.map(row => row.id)).size).toBe(1);
    expect(results[0]).toMatchObject({ byteCount: BigInt(1000), sha256: f.artifact.sha256, retentionClass: "PREVIEW" });
    expect(await prisma.sourceVideo.findUnique({ where: { id: f.source.id } })).toMatchObject({ width: 1920, height: 1080 });
    await expect(registerMediaArtifact(prisma, f.workspace.id, { ...f.artifact, sha256: "e".repeat(64) }))
      .rejects.toThrow("MEDIA_ARTIFACT_IDENTITY_CONFLICT");
  });

  it("does not overwrite a later expiry or verification when registration retries", async () => {
    const f = await fixture();
    const row = await registerMediaArtifact(prisma, f.workspace.id, f.artifact);
    const expiry = new Date("2030-01-01T00:00:00Z");
    await prisma.derivedMediaArtifact.update({ where: { id: row.id }, data: {
      expiresAt: expiry, mappingStatus: "VERIFIED", mappingEvidenceSha256: "e".repeat(64),
    } });
    expect(await registerMediaArtifact(prisma, f.workspace.id, f.artifact))
      .toMatchObject({ expiresAt: expiry, mappingStatus: "VERIFIED" });
  });

  it("rejects cross-workspace registration for artifacts and regions", async () => {
    const f = await fixture();
    await expect(registerMediaArtifact(prisma, randomUUID(), f.artifact)).rejects.toThrow("MEDIA_SOURCE_NOT_FOUND");
    await expect(recordMediaRegion(prisma, randomUUID(), f.region)).rejects.toThrow("MEDIA_SOURCE_NOT_FOUND");
    expect(await prisma.derivedMediaArtifact.count({ where: { sourceVideoId: f.source.id } })).toBe(0);
  });

  it("keeps overlapping region facts through project removal and new analysis ownership", async () => {
    const f = await fixture();
    const rows = await Promise.all(Array.from({ length: 3 }, () => recordMediaRegion(prisma, f.workspace.id, f.region)));
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    await recordMediaRegion(prisma, f.workspace.id, { ...f.region, kind: "SERMON", slideSubtype: null });
    await prisma.project.delete({ where: { id: f.project.id } });
    await prisma.project.create({ data: { workspaceId: f.workspace.id, sourceVideoId: f.source.id, name: "New analysis" } });
    expect(await prisma.mediaRegion.count({ where: { sourceVideoId: f.source.id } })).toBe(2);
  });

  it("separates detector versions and changed transcript inputs without overwriting facts", async () => {
    const f = await fixture();
    const original = await recordMediaRegion(prisma, f.workspace.id, f.region);
    await recordMediaRegion(prisma, f.workspace.id, { ...f.region, detectorVersion: "fixture-v2" });
    await recordMediaRegion(prisma, f.workspace.id, { ...f.region, inputSha256: "e".repeat(64) });
    expect(await prisma.mediaRegion.count({ where: { sourceVideoId: f.source.id } })).toBe(3);
    await expect(recordMediaRegion(prisma, f.workspace.id, { ...f.region, confidence: 0.9 }))
      .rejects.toThrow("MEDIA_REGION_IDENTITY_CONFLICT");
    await expect(prisma.mediaRegion.update({ where: { id: original.id }, data: { confidence: 0.9 } })).rejects.toThrow();
  });

  it("blocks artifact removal and source cascades before recorded storage deletion", async () => {
    const f = await fixture();
    const row = await registerMediaArtifact(prisma, f.workspace.id, f.artifact);
    await expect(prisma.derivedMediaArtifact.delete({ where: { id: row.id } })).rejects.toThrow();
    await expect(prisma.sourceVideo.delete({ where: { id: f.source.id } })).rejects.toThrow();
    await expect(prisma.workspace.delete({ where: { id: f.workspace.id } })).rejects.toThrow();
    expect(await prisma.derivedMediaArtifact.count({ where: { id: row.id } })).toBe(1);
  });

  it("keeps deleted identities retired and permits explicit record disposal afterward", async () => {
    const f = await fixture();
    const row = await registerMediaArtifact(prisma, f.workspace.id, f.artifact);
    await prisma.derivedMediaArtifact.update({ where: { id: row.id }, data: {
      deletedAt: new Date(), deletionEvidence: { fixtureOnly: true, noStorageObjectCreated: true },
    } });
    await expect(registerMediaArtifact(prisma, f.workspace.id, f.artifact)).rejects.toThrow("MEDIA_ARTIFACT_ALREADY_DELETED");
    await expect(prisma.derivedMediaArtifact.update({ where: { id: row.id }, data: { deletedAt: null, deletionEvidence: undefined } }))
      .rejects.toThrow();
    await prisma.derivedMediaArtifact.delete({ where: { id: row.id } });
    await prisma.project.delete({ where: { id: f.project.id } });
    await prisma.sourceVideo.delete({ where: { id: f.source.id } });
  });

  it("enforces byte identity and deletion checks below the application validator", async () => {
    const f = await fixture();
    const row = await registerMediaArtifact(prisma, f.workspace.id, f.artifact);
    await expect(prisma.derivedMediaArtifact.update({ where: { id: row.id }, data: { storageKey: "changed" } })).rejects.toThrow();
    await expect(prisma.derivedMediaArtifact.update({ where: { id: row.id }, data: { deletedAt: new Date() } })).rejects.toThrow();
    await expect(prisma.derivedMediaArtifact.update({ where: { id: row.id }, data: { mappingStatus: "VERIFIED" } })).rejects.toThrow();
    await expect(prisma.derivedMediaArtifact.create({ data: {
      ...row, id: randomUUID(), identityKey: "f".repeat(64), storageKey: `fixture/${randomUUID()}`,
      byteCount: BigInt(0), deletionEvidence: Prisma.DbNull, publicationEvidence: Prisma.DbNull,
    } })).rejects.toThrow();
  });

  it("keeps legacy transcript metadata unknown and preserves generated search", async () => {
    const f = await fixture();
    const transcript = await prisma.transcript.create({ data: {
      sourceVideoId: f.source.id, language: "en", provider: "fixture", fullText: "Grace and mercy",
    } });
    expect(transcript).toMatchObject({ capabilities: null, provenance: null });
    const search = await prisma.$queryRaw<{ found: boolean }[]>`
      SELECT search_vector @@ plainto_tsquery('english', 'mercy') AS found FROM transcripts WHERE id = ${transcript.id}::uuid
    `;
    expect(search).toEqual([{ found: true }]);
    await expect(prisma.transcript.update({ where: { id: transcript.id }, data: { capabilities: {} } })).rejects.toThrow();
  });
});

describe("consecutive scripture slide persistence", () => {
  it("atomically deduplicates inputs and groups while retaining immutable evidence", async () => {
    const f = await fixture();
    const slides = [f.region, { ...f.region, sourceInterval: { startMs: 2000, endMs: 3000 } }];
    const input = { sourceVideoId: f.source.id, sourceSha256: f.region.sourceSha256, maxGapMs: 0, slides };
    const results = await Promise.all([recordSlideRegionBatch(prisma, f.workspace.id, input),
      recordSlideRegionBatch(prisma, f.workspace.id, { ...input, slides: slides.toReversed() })]);
    expect(results[0].groups[0].id).toBe(results[1].groups[0].id);
    expect(await prisma.mediaRegion.count({ where: { sourceVideoId: f.source.id } })).toBe(3);
    expect(results[0].groups[0]).toMatchObject({ kind: "VERSE_SLIDESHOW", startMs: BigInt(1000), endMs: BigInt(3000),
      derivationEvidence: { parentIdentityKeys: results[0].slides.map(slide => slide.identityKey), maxGapMs: 0 } });
    await expect(prisma.mediaRegion.update({ where: { id: results[0].groups[0].id },
      data: { derivationEvidence: { changed: true } } })).rejects.toThrow("MEDIA_REGION_IMMUTABLE");
    await prisma.project.delete({ where: { id: f.project.id } });
    expect(await prisma.mediaRegion.count({ where: { sourceVideoId: f.source.id } })).toBe(3);
  });
  it("rolls back input facts when derived group persistence fails", async () => {
    const f = await fixture();
    const broken = prisma.$extends({ query: { mediaRegion: { async create({ args, query }) {
      if (args.data.kind === "VERSE_SLIDESHOW") throw new Error("injected group failure");
      return query(args);
    } } } }) as unknown as PrismaClient;
    await expect(recordSlideRegionBatch(broken, f.workspace.id, { sourceVideoId: f.source.id,
      sourceSha256: f.region.sourceSha256, maxGapMs: 0,
      slides: [f.region, { ...f.region, sourceInterval: { startMs: 2000, endMs: 3000 } }] }))
      .rejects.toThrow("injected group failure");
    expect(await prisma.mediaRegion.count({ where: { sourceVideoId: f.source.id } })).toBe(0);
  });
});
