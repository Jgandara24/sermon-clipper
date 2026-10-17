import { prepareAnthropicVisualBoundaryRequest } from "@/lib/media/anthropic-visual-escalation";
import { proxyViewEvidenceSchema } from "@/lib/media/proxy-views";
import { z } from "zod";
import { runVisualBoundaryEscalationOnce, type VisualEscalationRequest } from "@/lib/media/visual-escalation";
import type { BoundaryAsrBatchRequest } from "@/lib/media/boundary-asr-batch";
import { claimRangePublication } from "@/lib/delivery/range-publication-claim";
import { loadDeliveryFacts } from "@/lib/delivery/query";
import { assessDeliveryEligibility } from "@/lib/delivery/eligibility";
import { recordMediaRegion } from "@/lib/media-regions/persistence";
import { assertOriginalRegionExportAllowed } from "@/lib/media-regions/export-policy";
import * as storageModule from "@/lib/storage";
import * as transcriptionModule from "@/lib/transcription";
import { runProbeJob } from "@/lib/jobs/handlers/probe";
import { runTranscribeJob } from "@/lib/jobs/handlers/transcribe";
import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withMaterializedSource, SourceMediaBusyError } from "@/lib/media/source-lease";
import { prepareSermonSource } from "@/lib/media/sermon-preparation";
import { extractSermonAudio } from "@/lib/media/sermon-audio";
import { buildSubmissionTranscriptStructure, persistSermonSubmission } from "@/lib/transcription/persist-submission";
import { transcribeRegisteredSermonAudio } from "@/lib/transcription/registered-sermon";
import { ScribeTranscriptionProvider } from "@/lib/transcription/scribe-provider";
import { rangeEvidenceSha256 } from "@/lib/media/range-evidence";
import { runSermonSubmissionOnce } from "@/lib/transcription/submission-ledger";
import { runCandidateRangeBatch } from "@/lib/media/range-batch";
import { runAnalysisDerivativeBatch, type AnalysisBatchOcrRequest } from "@/lib/media/analysis-batch";
import { buildAnalysisDerivatives } from "@/lib/media/analysis-derivatives";
import { runExportJob } from "@/lib/exports/handler";
import { probeVideoFile } from "@/lib/media/probe";
import { claimNextExportJob, enqueueExportJob, markExportJobSucceeded } from "@/lib/exports/queue";
import { coordinateScheduledRenders } from "@/lib/review/render-coordinator";
import { assessFinalRender } from "@/lib/review/final-render-eligibility";
import { enqueueFullSourceFallbackExport } from "@/lib/exports/full-source-fallback";
import { requestFullSourceFallback } from "@/lib/exports/full-source-fallback-request";
import { attemptEarlyOriginalDeletion } from "@/lib/media/early-original-deletion";
import { lockMediaSource } from "@/lib/media-artifacts/persistence";
import { buildDefaultEditorState } from "@/lib/editor/types";
import { enqueueRangeExportJob, enqueueRangeExportJobInTransaction, prepareExportRangeInput } from "@/lib/exports/range-input";
import { recordArtifactReview } from "@/lib/media-artifacts/review";
import { withMaterializedRange } from "@/lib/media-artifacts/read-lease";
import { cleanupExpiredMediaArtifacts } from "@/lib/media-artifacts/cleanup";
import { artifactIdentityKey } from "@/lib/media-artifacts/types";
import { registerMediaArtifact } from "@/lib/media-artifacts/persistence";
import { publishMediaArtifact } from "@/lib/media-artifacts/publication";
import { fileIdentity } from "@/lib/storage/file-identity";
import type { ArtifactRecord } from "@/lib/media-artifacts/types";
import { runCleanupJob } from "@/lib/jobs/handlers/cleanup";
import { closeStorageProvider, getStorageProvider } from "@/lib/storage";
import { LocalDiskStorageProvider } from "@/lib/storage/local-disk-provider";
import type { StorageObjectIdentity } from "@/lib/storage/types";

// Sessions and their audit are deliberately immutable. Run only in the named disposable database.
describe.skipIf(process.env.P4_LEASE_TEST_DATABASE !== "1")("source media lease and retention", () => {
  const prisma = new PrismaClient();
  const secondClient = new PrismaClient();
  let root: string;
  let provider: CountingStorage;
  const previousDeletion = process.env.SOURCE_RETENTION_DELETION_ENABLED;
  const previousStorage = process.env.STORAGE_LOCAL_ROOT;
  const previousProvider = process.env.STORAGE_PROVIDER;
  const previousCache = process.env.STORAGE_CACHE_MAX_BYTES;

  class CountingStorage extends LocalDiskStorageProvider {
    uploads = 0;
    async uploadFileIfAbsent(key: string, file: string) {
      this.uploads++;
      return super.uploadFileIfAbsent(key, file);
    }
    downloads = 0;
    downloadKeys: string[] = [];
    fail = false;
    async downloadToFile(key: string, destination: string, expected?: StorageObjectIdentity) {
      this.downloads++;
      this.downloadKeys.push(key);
      if (this.fail) throw new Error("Fixture acquisition failure");
      return super.downloadToFile(key, destination, expected);
    }
  }

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.pathname !== "/p4_lease" || url.hostname !== "localhost") throw new Error("Disposable p4_lease database required.");
    root = await mkdtemp(path.join(os.tmpdir(), "source-lease-test-"));
    await mkdir(path.join(root, "storage"));
    await closeStorageProvider();
    process.env.STORAGE_PROVIDER = "local";
    process.env.STORAGE_LOCAL_ROOT = path.join(root, "storage");
    process.env.STORAGE_CACHE_MAX_BYTES = "0";
    process.env.SOURCE_RETENTION_DELETION_ENABLED = "true";
    provider = new CountingStorage(path.join(root, "storage"));
  });
  afterAll(async () => {
    await closeStorageProvider();
    await prisma.$disconnect(); await secondClient.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries({ SOURCE_RETENTION_DELETION_ENABLED: previousDeletion,
      STORAGE_LOCAL_ROOT: previousStorage, STORAGE_PROVIDER: previousProvider, STORAGE_CACHE_MAX_BYTES: previousCache })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    // The harness removes the entire disposable database, including immutable session history.
  });

  async function fixture() {
    const user = await prisma.user.create({ data: { email: `p4-lease-${randomUUID()}@example.test` } });
    const workspace = await prisma.workspace.create({ data: { ownerId: user.id, name: "Lease fixture" } });
    const key = randomUUID();
    await writeFile(provider.absolutePath(key), "source bytes for one project batch");
    const source = await prisma.sourceVideo.create({ data: { workspaceId: workspace.id, origin: "UPLOAD",
      storageKey: key, width: 1920, height: 1080, durationS: 60 } });
    const project = await prisma.project.create({ data: { workspaceId: workspace.id, sourceVideoId: source.id,
      name: "Expired fixture", status: "READY", expiresAt: new Date("2020-01-01") } });
    const job = await prisma.processingJob.create({ data: { projectId: project.id, type: "CLEANUP", idempotencyKey: randomUUID() } });
    const request = { workspaceId: workspace.id, sourceVideoId: source.id, ownerId: randomUUID(), temporaryRoot: path.join(root, "work") };
    return { source, project, job, request, workspace };
  }

  async function artifactInput(sourceId: string, file: string): Promise<ArtifactRecord> {
    const bytes = await fileIdentity(file);
    return { sourceVideoId: sourceId, sourceSha256: "a".repeat(64), kind: "ANALYSIS_AUDIO",
      derivationVersion: "fixture-v1", configurationSha256: "b".repeat(64),
      sourceInterval: { startMs: 0, endMs: 1000 }, storageKey: `artifacts/${randomUUID()}`,
      sha256: bytes.sha256, byteCount: BigInt(bytes.byteCount), retentionClass: "ANALYSIS",
      expiresAt: null, mappingStatus: "DECLARED", mappingEvidenceSha256: null, visualQuality: "NOT_APPLICABLE" };
  }

  async function withSubmissionFixture(work: (request: Parameters<typeof runSermonSubmissionOnce>[1], artifactId: string) => Promise<void>) {
    const f = await fixture();
    await withMaterializedSource(prisma, provider, f.request, async source => {
      const base = await artifactInput(source.sourceVideoId, source.sourcePath);
      const identity = { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256, kind: "SERMON_AUDIO" as const,
        sourceInterval: base.sourceInterval, derivationVersion: "ledger-fixture-v1", configurationSha256: base.configurationSha256 };
      // Simulated artifact tests the database protocol, not audio content or corridor accuracy.
      const { artifact } = await publishMediaArtifact(prisma, provider,
        { workspaceId: f.workspace.id, sessionId: source.sessionId, ownerId: f.request.ownerId },
        { ...base, ...identity, storageKey: `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.flac`,
          mappingStatus: "VERIFIED", mappingEvidenceSha256: "c".repeat(64) }, source.sourcePath);
      await work({ workspaceId: f.workspace.id, sourceVideoId: f.source.id, artifactId: artifact.id,
        sessionId: source.sessionId, ownerId: f.request.ownerId }, artifact.id);
    });
    return f;
  }

  it("reuses durable completed transcription results and rejects ledger mutation", async () => {
    await withSubmissionFixture(async request => {
      let calls = 0;
      const submit = async () => { calls++; return { transcript: "fixture response", sourceOffsetMs: 0 }; };
      const first = await runSermonSubmissionOnce(prisma, request, submit);
      const second = await runSermonSubmissionOnce(prisma, request, submit);
      expect(calls).toBe(1);
      expect(first.reused).toBe(false);
      expect(second).toEqual({ ...first, reused: true });
      await expect(prisma.sermonTranscriptionSubmission.update({ where: { id: first.submissionId },
        data: { result: { transcript: "changed" } } })).rejects.toThrow("SERMON_SUBMISSION_IMMUTABLE");
      await expect(prisma.sermonTranscriptionSubmission.delete({ where: { id: first.submissionId } }))
        .rejects.toThrow("SERMON_SUBMISSION_IMMUTABLE");
    });
  });

  it("refuses a second invocation while the first provider request is running", async () => {
    await withSubmissionFixture(async request => {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      let calls = 0;
      const first = runSermonSubmissionOnce(prisma, request, async () => {
        calls++; entered(); await gate; return { transcript: "one response" };
      });
      await started;
      try {
        await expect(runSermonSubmissionOnce(secondClient, request, async () => {
          calls++; return { transcript: "duplicate" };
        })).rejects.toThrow("SERMON_SUBMISSION_UNCERTAIN");
      } finally { release(); }
      await first;
      expect(calls).toBe(1);
    });
  });

  it("blocks uncertain transcription retries and retains their audio", async () => {
    let artifactId = "";
    const f = await withSubmissionFixture(async (request, id) => {
      artifactId = id;
      let calls = 0;
      const submit = async () => { calls++; throw new Error("Unknown provider outcome"); };
      await expect(runSermonSubmissionOnce(prisma, request, submit)).rejects.toThrow("Unknown provider outcome");
      await expect(runSermonSubmissionOnce(prisma, request, submit)).rejects.toThrow("SERMON_SUBMISSION_UNCERTAIN");
      await expect(runSermonSubmissionOnce(prisma, { ...request, language: "es" }, submit)).rejects.toThrow("SOURCE_UNCERTAIN");
      expect(calls).toBe(1);
      expect(await prisma.sermonTranscriptionSubmission.findFirst({ where: { artifactId: id } })).toMatchObject({ state: "UNCERTAIN" });
    });
    await prisma.derivedMediaArtifact.update({ where: { id: artifactId }, data: { expiresAt: new Date("2020-01-01") } });
    await cleanupExpiredMediaArtifacts(prisma, provider, { workspaceId: f.workspace.id, sourceVideoId: f.source.id,
      ownerId: randomUUID(), maxArtifacts: 10 });
    expect(await prisma.derivedMediaArtifact.findUnique({ where: { id: artifactId } })).toMatchObject({ deletedAt: null });
  });

  async function readableRange() {
    const f = await fixture();
    let artifact!: Awaited<ReturnType<typeof publishMediaArtifact>>["artifact"];
    await withMaterializedSource(prisma, provider, f.request, async source => {
      const base = await artifactInput(source.sourceVideoId, source.sourcePath);
      const identity = { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256, kind: "CANDIDATE_RANGE" as const,
        sourceInterval: base.sourceInterval, derivationVersion: "read-lease-fixture-v1", configurationSha256: base.configurationSha256 };
      // This fixture tests the read protocol. It does not represent production media or visual approval.
      artifact = (await publishMediaArtifact(prisma, provider,
        { workspaceId: f.workspace.id, sessionId: source.sessionId, ownerId: f.request.ownerId },
        { ...base, ...identity, storageKey: `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.nut`,
          retentionClass: "RENDER_SOURCE", mappingStatus: "VERIFIED", mappingEvidenceSha256: "c".repeat(64), visualQuality: "NOT_REVIEWED" },
        source.sourcePath)).artifact;
    });
    const reviewInput = { workspaceId: f.workspace.id, sourceVideoId: f.source.id, artifactId: artifact.id,
      reviewerId: f.workspace.ownerId, expectedRevision: 0, decision: "ACCEPTED" as const,
      sourceSha256: artifact.sourceSha256, artifactSha256: artifact.sha256,
      mappingEvidenceSha256: artifact.mappingEvidenceSha256!, evidence: { comparisonReference: "fixture-only",
        notes: "Simulated protocol review, not production approval.", fullRangeCompared: true,
        dimensionsChecked: true, timingChecked: true, visualQualityAcceptable: true } };
    await recordArtifactReview(prisma, reviewInput);
    artifact = await prisma.derivedMediaArtifact.findUniqueOrThrow({ where: { id: artifact.id } });
    return { ...f, reviewInput, artifact, readRequest: { ...f.request, artifactId: artifact.id,
      sourceSha256: artifact.sourceSha256, sourceRange: { startMs: 100, endMs: 900 } } };
  }

  async function queuedRangePin() {
    const f = await readableRange();
    const clip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 100, endMs: 900, title: "Retention fixture", summary: "Local pin fixture" } });
    const job = await prisma.exportJob.create({ data: { workspaceId: f.workspace.id, clipId: clip.id,
      filename: "fixture.mp4", editVersion: 0, idempotencyKey: `export:${clip.id}:v0` } });
    const pin = await prepareExportRangeInput(prisma, { workspaceId: f.workspace.id, exportJobId: job.id, artifactId: f.artifact.id });
    return { ...f, job, pin };
  }

  async function queuedOriginalPublication() {
    const f = await fixture();
    const clip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 100, endMs: 900, title: "Original publication fixture", summary: "Protocol fixture" } });
    const job = await prisma.exportJob.create({ data: { workspaceId: f.workspace.id, clipId: clip.id,
      // A publication fixture models a rendered export. A queued row would be claimable by later queue tests.
      filename: "fixture.mp4", editVersion: 0, idempotencyKey: `export:${clip.id}:v0`, state: "SUCCEEDED",
      qcDetails: { mediaInput: { kind: "ORIGINAL", sourceVideoId: f.source.id,
        sourceInterval: { startMs: 100, endMs: 900 }, editVersion: 0 } } } });
    return { ...f, job, artifact: { sourceSha256: "a".repeat(64) } };
  }

  it.each(["clear", "forbidden", "intent-failure", "original-clear", "original-forbidden", "original-intent-failure", "original-missing-evidence"] as const)("atomically claims source publication (%s)", async scenario => {
    const original = scenario.startsWith("original-");
    const mode = scenario.replace("original-", "");
    const f = original ? await queuedOriginalPublication() : await queuedRangePin();
    // Protocol fixture only: no real render approval or external publishing occurs.
    await prisma.exportJob.update({ where: { id: f.job.id }, data: { state: "SUCCEEDED" } });
    const slot = await prisma.scheduledPost.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      clipId: f.job.clipId, exportJobId: f.job.id, scheduledDate: new Date("2026-10-16") } });
    const request = { workspaceId: f.workspace.id, scheduledPostId: slot.id, clipId: f.job.clipId,
      exportJobId: f.job.id, now: new Date() };
    expect((await loadDeliveryFacts(prisma, { scheduledPostId: slot.id }))?.exportJob)
      .toMatchObject({ sourceRegionStatus: "clear", usesRangeInput: !original });
    if (mode === "missing-evidence") {
      await prisma.exportJob.update({ where: { id: f.job.id }, data: { qcDetails: {} } });
      expect((await loadDeliveryFacts(prisma, { scheduledPostId: slot.id }))?.exportJob?.sourceRegionStatus).toBe("unavailable");
      expect(await claimRangePublication(prisma, request)).toEqual({ status: "INELIGIBLE", reason: "source_region_check_unavailable" });
      expect(await prisma.publishAttempt.count({ where: { scheduledPostId: slot.id } })).toBe(0);
      return;
    }
    if (mode === "forbidden") {
      await recordMediaRegion(prisma, f.workspace.id, { sourceVideoId: f.source.id, sourceSha256: f.artifact.sourceSha256,
        sourceInterval: { startMs: 200, endMs: 300 }, kind: "PRAYER", detectorVersion: "fixture",
        configurationSha256: "a".repeat(64), inputSha256: "b".repeat(64), evidenceSha256: "c".repeat(64),
        confidence: 0.1, slideSubtype: null, ocrEvidence: null });
      expect((await loadDeliveryFacts(prisma, { scheduledPostId: slot.id }))?.exportJob?.sourceRegionStatus).toBe("blocked");
      expect(await claimRangePublication(prisma, request)).toEqual({ status: "INELIGIBLE", reason: "source_region_forbidden" });
      expect(await prisma.scheduledPost.findUnique({ where: { id: slot.id } })).toMatchObject({ publishStatus: "NOT_STARTED" });
      expect(await prisma.publishAttempt.count({ where: { scheduledPostId: slot.id } })).toBe(0);
      return;
    }
    if (mode === "intent-failure") {
      const broken = prisma.$extends({ query: { publishAttempt: { async create() { throw new Error("injected intent failure"); } } } }) as unknown as PrismaClient;
      await expect(claimRangePublication(broken, request)).rejects.toThrow("injected intent failure");
      expect(await prisma.scheduledPost.findUnique({ where: { id: slot.id } })).toMatchObject({ publishStatus: "NOT_STARTED" });
      expect(await prisma.publishAttempt.count({ where: { scheduledPostId: slot.id } })).toBe(0);
    }
    const outcomes = await Promise.all([claimRangePublication(prisma, request), claimRangePublication(secondClient, request)]);
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(["CLAIMED", "LOST"]);
    expect(await prisma.publishAttempt.findMany({ where: { scheduledPostId: slot.id } })).toEqual([
      expect.objectContaining({ state: "INTENT", expectedClipId: f.job.clipId, expectedExportJobId: f.job.id }),
    ]);
    expect(await prisma.scheduledPost.findUnique({ where: { id: slot.id } })).toMatchObject({ publishStatus: "IN_PROGRESS" });
  });

  it.each(["before", "after", "missing"] as const)("checks original publication interval evidence (%s)", async mode => {
    const f = await queuedOriginalPublication();
    if (mode === "missing") await prisma.exportJob.update({ where: { id: f.job.id }, data: { qcDetails: {} } });
    const slot = await prisma.scheduledPost.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      clipId: f.job.clipId, exportJobId: f.job.id, scheduledDate: new Date("2026-10-16"), publishStatus: "SUCCEEDED" } });
    await recordMediaRegion(prisma, f.workspace.id, { sourceVideoId: f.source.id, sourceSha256: "d".repeat(64),
      sourceInterval: mode === "after" ? { startMs: 900, endMs: 1000 } : { startMs: 0, endMs: 100 },
      kind: "PRAYER", detectorVersion: "fixture", configurationSha256: "a".repeat(64), inputSha256: "b".repeat(64),
      evidenceSha256: "c".repeat(64), confidence: 0.1, slideSubtype: null, ocrEvidence: null });
    expect(await prisma.editorialException.count({ where: { scheduledPostId: slot.id } })).toBe(mode === "missing" ? 1 : 0);
  });

  it.each([
    { publishStatus: "IN_PROGRESS", original: false }, { publishStatus: "SUCCEEDED", original: false },
    { publishStatus: "IN_PROGRESS", original: true }, { publishStatus: "SUCCEEDED", original: true },
  ] as const)("records late region review for $publishStatus publication (original=$original)", async ({ publishStatus, original }) => {
    const f = original ? await queuedOriginalPublication() : await queuedRangePin();
    // Simulated publication state only. No provider request runs.
    const slot = await prisma.scheduledPost.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      clipId: f.job.clipId, exportJobId: f.job.id, scheduledDate: new Date("2026-10-16"),
      publishStatus, facebookPostId: publishStatus === "SUCCEEDED" ? "fixture-remote-id" : null } });
    const fact = { sourceVideoId: f.source.id, sourceSha256: f.artifact.sourceSha256,
      sourceInterval: { startMs: 200, endMs: 300 }, kind: "PRAYER" as const, detectorVersion: "fixture",
      configurationSha256: "a".repeat(64), inputSha256: "b".repeat(64), evidenceSha256: "c".repeat(64),
      confidence: 0.1, slideSubtype: null, ocrEvidence: null };
    const broken = prisma.$extends({ query: { editorialException: {
      async create() { throw new Error("injected exception failure"); },
    } } }) as unknown as PrismaClient;
    await expect(recordMediaRegion(broken, f.workspace.id, fact)).rejects.toThrow("injected exception failure");
    expect(await prisma.mediaRegion.count({ where: { sourceVideoId: f.source.id } })).toBe(0);
    const regions = await Promise.all([recordMediaRegion(prisma, f.workspace.id, fact),
      recordMediaRegion(secondClient, f.workspace.id, fact)]);
    expect(regions[0].id).toBe(regions[1].id);
    const exceptions = await prisma.editorialException.findMany({ where: { scheduledPostId: slot.id } });
    expect(exceptions).toEqual([expect.objectContaining({ state: "OPEN",
      exceptionType: "SOURCE_REGION_CHANGED_AFTER_CLAIM",
      metadata: expect.objectContaining({ regionId: regions[0].id, providerActionTaken: false }) })]);
    await prisma.editorialException.update({ where: { id: exceptions[0].id }, data: { state: "RESOLVED" } });
    await recordMediaRegion(prisma, f.workspace.id, fact);
    expect(await prisma.editorialException.findMany({ where: { scheduledPostId: slot.id } }))
      .toEqual([expect.objectContaining({ id: exceptions[0].id, state: "RESOLVED" })]);
    expect(await prisma.scheduledPost.findUnique({ where: { id: slot.id } }))
      .toMatchObject({ publishStatus, facebookPostId: slot.facebookPostId });
  });

  it.each(["sermon", "visible", "touching", "checksum", "queued"] as const)("excludes unrelated late evidence (%s)", async mode => {
    const f = await queuedRangePin();
    const slot = await prisma.scheduledPost.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      clipId: f.job.clipId, exportJobId: f.job.id, scheduledDate: new Date("2026-10-16"),
      publishStatus: mode === "queued" ? "NOT_STARTED" : "SUCCEEDED" } });
    await recordMediaRegion(prisma, f.workspace.id, {
      sourceVideoId: f.source.id, sourceSha256: mode === "checksum" ? "d".repeat(64) : f.artifact.sourceSha256,
      sourceInterval: mode === "touching" ? { startMs: 900, endMs: 1000 } : { startMs: 200, endMs: 300 },
      kind: mode === "sermon" ? "SERMON" : mode === "visible" ? "PASTOR_VISIBLE" : "PRAYER",
      detectorVersion: "fixture", configurationSha256: "a".repeat(64), inputSha256: "b".repeat(64),
      evidenceSha256: "c".repeat(64), confidence: 0.1, slideSubtype: null, ocrEvidence: null });
    expect(await prisma.editorialException.count({ where: { scheduledPostId: slot.id } })).toBe(0);
  });

  it("atomically queues range exports and reuses concurrent matching requests", async () => {
    const f = await readableRange();
    const clip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 100, endMs: 900, title: "Atomic fixture", summary: "Local fixture" } });
    const request = { workspaceId: f.workspace.id, clipId: clip.id, artifactId: f.artifact.id,
      filename: "atomic.mp4", editVersion: 0 };
    const [first, second] = await Promise.all([enqueueRangeExportJob(prisma, request), enqueueRangeExportJob(prisma, request)]);
    expect(first.job.id).toBe(second.job.id);
    expect(first.pin).toEqual(second.pin);
    expect(await prisma.exportJob.count({ where: { clipId: clip.id } })).toBe(1);
    await expect(enqueueRangeExportJob(prisma, { ...request, artifactId: randomUUID() })).rejects.toThrow("INPUT_CONFLICT");
    await prisma.exportJob.update({ where: { id: first.job.id }, data: { state: "CANCELED" } });
  });

  it("rolls back jobs when pin validation or the caller transaction fails", async () => {
    const f = await readableRange();
    const clip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 100, endMs: 900, title: "Rollback fixture", summary: "Local fixture" } });
    const request = { workspaceId: f.workspace.id, clipId: clip.id, artifactId: f.artifact.id,
      filename: "atomic.mp4", editVersion: 0 };
    await expect(enqueueRangeExportJob(prisma, { ...request, artifactId: randomUUID() })).rejects.toThrow("NOT_APPROVED_OR_COVERED");
    expect(await prisma.exportJob.count({ where: { clipId: clip.id } })).toBe(0);
    await expect(prisma.$transaction(async tx => {
      await enqueueRangeExportJobInTransaction(tx, request);
      throw new Error("CALLER_ROLLBACK");
    })).rejects.toThrow("CALLER_ROLLBACK");
    expect(await prisma.exportJob.count({ where: { clipId: clip.id } })).toBe(0);
    const original = await prisma.exportJob.create({ data: { workspaceId: f.workspace.id, clipId: clip.id,
      filename: "original.mp4", editVersion: 0, idempotencyKey: `export:${clip.id}:v0` } });
    await expect(enqueueRangeExportJob(prisma, request)).rejects.toThrow("EXISTING_ORIGINAL_JOB");
    expect(await prisma.exportRangeInput.findUnique({ where: { exportJobId: original.id } })).toBeNull();
    await prisma.exportJob.update({ where: { id: original.id }, data: { state: "CANCELED" } });
  });

  it("selects approved ranges through the shared queue and rolls back caller changes when coverage is missing", async () => {
    const f = await readableRange();
    const clip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 100, endMs: 900, title: "Shared queue", summary: "Local fixture" } });
    const request = { workspaceId: f.workspace.id, clipId: clip.id, filename: "shared.mp4", editVersion: 0 };
    const previous = process.env.P4_RANGE_EXPORTS_ENABLED;
    process.env.P4_RANGE_EXPORTS_ENABLED = "true";
    try {
      const job = await enqueueExportJob(prisma, request);
      expect(await prisma.exportRangeInput.findUnique({ where: { exportJobId: job.id } }))
        .toMatchObject({ artifactId: f.artifact.id, startMs: BigInt(100), endMs: BigInt(900) });
      expect((await enqueueExportJob(prisma, request)).id).toBe(job.id);
      await prisma.exportJob.update({ where: { id: job.id }, data: { state: "CANCELED" } });
      const uncovered = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
        rank: 2, startMs: 2000, endMs: 3000, title: "Uncovered", summary: "Local fixture" } });
      await expect(prisma.$transaction(async tx => {
        await tx.generatedClip.update({ where: { id: uncovered.id }, data: { title: "Promoted" } });
        await enqueueExportJob(tx, { ...request, clipId: uncovered.id });
      })).rejects.toThrow("EXPORT_RANGE_UNAVAILABLE");
      expect(await prisma.generatedClip.findUnique({ where: { id: uncovered.id } })).toMatchObject({ title: "Uncovered" });
      expect(await prisma.exportJob.count({ where: { clipId: uncovered.id } })).toBe(0);
      await prisma.generatedClip.update({ where: { id: uncovered.id }, data: { startMs: 100, endMs: 900 } });
      const transactionJob = await prisma.$transaction(tx => enqueueExportJob(tx, { ...request, clipId: uncovered.id }));
      expect(await prisma.exportRangeInput.findUnique({ where: { exportJobId: transactionJob.id } })).not.toBeNull();
      await prisma.exportJob.update({ where: { id: transactionJob.id }, data: { state: "CANCELED" } });
    } finally {
      if (previous === undefined) delete process.env.P4_RANGE_EXPORTS_ENABLED; else process.env.P4_RANGE_EXPORTS_ENABLED = previous;
    }
  });

  async function withExportSwitches<T>(range: string | undefined, fallback: string | undefined, work: () => Promise<T>) {
    const previous = [process.env.P4_RANGE_EXPORTS_ENABLED, process.env.P4_FULL_SOURCE_EXPORT_FALLBACK_ENABLED];
    const set = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    set("P4_RANGE_EXPORTS_ENABLED", range); set("P4_FULL_SOURCE_EXPORT_FALLBACK_ENABLED", fallback);
    try { return await work(); } finally {
      set("P4_RANGE_EXPORTS_ENABLED", previous[0]); set("P4_FULL_SOURCE_EXPORT_FALLBACK_ENABLED", previous[1]);
    }
  }

  it("creates one explicit full-source fallback with an open exception and refuses unneeded fallbacks", async () => {
    const f = await readableRange();
    const covered = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 100, endMs: 900, title: "Covered", summary: "Local fixture" } });
    const uncovered = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 2, startMs: 2000, endMs: 3000, title: "Uncovered", summary: "Local fixture" } });
    const request = { workspaceId: f.workspace.id, clipId: uncovered.id, requestedByUserId: f.workspace.ownerId,
      filename: "fallback.mp4", editVersion: 0, reason: "Fixture: no reviewed range exists." };
    await withExportSwitches(undefined, "true", () => expect(enqueueFullSourceFallbackExport(prisma, request))
      .rejects.toThrow("FULL_SOURCE_FALLBACK_RANGE_EXPORTS_DISABLED"));
    await withExportSwitches("true", undefined, () => expect(enqueueFullSourceFallbackExport(prisma, request))
      .rejects.toThrow("FULL_SOURCE_FALLBACK_DISABLED"));
    await withExportSwitches("true", "true", async () => {
      await expect(enqueueFullSourceFallbackExport(prisma, { ...request, clipId: covered.id }))
        .rejects.toThrow("FULL_SOURCE_FALLBACK_RANGE_AVAILABLE");
      await expect(enqueueFullSourceFallbackExport(prisma, { ...request, reason: "   " })).rejects.toThrow();
      expect(await prisma.exportJob.count({ where: { clipId: { in: [covered.id, uncovered.id] } } })).toBe(0);
      const [first, second] = await Promise.all([enqueueFullSourceFallbackExport(prisma, request),
        enqueueFullSourceFallbackExport(prisma, request)]);
      expect(first.job.id).toBe(second.job.id);
      expect([first.created, second.created].sort()).toEqual([false, true]);
      expect(await prisma.exportJob.count({ where: { clipId: uncovered.id } })).toBe(1);
      expect(await prisma.exportRangeInput.findUnique({ where: { exportJobId: first.job.id } })).toBeNull();
      expect(await prisma.editorialException.findMany({ where: { projectId: f.project.id, exceptionType: "full_source_export_fallback" } }))
        .toEqual([expect.objectContaining({ id: first.exception.id, state: "OPEN",
          metadata: expect.objectContaining({ exportJobId: first.job.id, sourceInterval: { startMs: 2000, endMs: 3000 } }) })]);
      expect(first.fallback).toMatchObject({ reasonCode: "EXPORT_RANGE_UNAVAILABLE", editVersion: 0,
        startMs: BigInt(2000), endMs: BigInt(3000), editorialExceptionId: first.exception.id });
      // The normal producer still refuses; it never adopts the fallback job as a range job.
      await expect(enqueueExportJob(prisma, { workspaceId: f.workspace.id, clipId: uncovered.id,
        filename: "normal.mp4", editVersion: 0 })).rejects.toThrow("EXPORT_RANGE_UNAVAILABLE");
      await expect(prisma.exportFullSourceFallback.update({ where: { id: first.fallback.id }, data: { reason: "changed" } }))
        .rejects.toThrow("FULL_SOURCE_FALLBACK_IMMUTABLE");
      const review = await prisma.mediaArtifactReview.findFirstOrThrow({ where: { artifactId: f.artifact.id } });
      await expect(prisma.exportRangeInput.create({ data: { exportJobId: first.job.id, artifactId: f.artifact.id,
        reviewId: review.id, sourceVideoId: f.source.id, sourceSha256: f.artifact.sourceSha256, artifactSha256: f.artifact.sha256,
        mappingEvidenceSha256: f.artifact.mappingEvidenceSha256!, editVersion: 0, startMs: BigInt(2000), endMs: BigInt(3000) } }))
        .rejects.toThrow("FULL_SOURCE_FALLBACK_RANGE_CONFLICT");
      await expect(prisma.editorialException.delete({ where: { id: first.exception.id } })).rejects.toThrow();
      const plain = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
        rank: 3, startMs: 3000, endMs: 4000, title: "Plain", summary: "Local fixture" } });
      await prisma.exportJob.create({ data: { workspaceId: f.workspace.id, clipId: plain.id, filename: "plain.mp4",
        editVersion: 0, idempotencyKey: `export:${plain.id}:v0`, state: "CANCELED" } });
      await expect(enqueueFullSourceFallbackExport(prisma, { ...request, clipId: plain.id }))
        .rejects.toThrow("FULL_SOURCE_FALLBACK_EXISTING_JOB");
      const unstored = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
        rank: 4, startMs: 4000, endMs: 5000, title: "Unstored", summary: "Local fixture" } });
      const key = f.source.storageKey;
      await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { storageKey: null } });
      try {
        await expect(enqueueFullSourceFallbackExport(prisma, { ...request, clipId: unstored.id }))
          .rejects.toThrow("FULL_SOURCE_FALLBACK_ORIGINAL_UNAVAILABLE");
      } finally { await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { storageKey: key } }); }
      expect(await prisma.exportJob.count({ where: { clipId: unstored.id } })).toBe(0);
      await prisma.exportJob.update({ where: { id: first.job.id }, data: { state: "CANCELED" } });
    });
  });

  it("requests a fallback through the shared operator entry with one event and clear refusals", async () => {
    const f = await readableRange();
    const covered = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 100, endMs: 900, title: "Covered", summary: "Local fixture" } });
    const uncovered = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 2, startMs: 2000, endMs: 3000, title: "Uncovered", summary: "Local fixture" } });
    const operator = f.workspace.ownerId;
    await withExportSwitches("true", "true", async () => {
      expect(await requestFullSourceFallback(prisma, { clipId: covered.id, operatorUserId: operator, reason: "Fixture" }))
        .toMatchObject({ ok: false, status: 409, code: "FULL_SOURCE_FALLBACK_RANGE_AVAILABLE" });
      expect(await requestFullSourceFallback(prisma, { clipId: randomUUID(), operatorUserId: operator, reason: "Fixture" }))
        .toMatchObject({ ok: false, status: 404 });
      const first = await requestFullSourceFallback(prisma, { clipId: uncovered.id, operatorUserId: operator, reason: "Fixture" });
      const again = await requestFullSourceFallback(prisma, { clipId: uncovered.id, operatorUserId: operator, reason: "Fixture" });
      expect(first).toMatchObject({ ok: true, created: true });
      expect(again).toMatchObject({ ok: true, created: false, exportJobId: first.ok ? first.exportJobId : "" });
      expect(await prisma.operationalEvent.count({ where: { clipId: uncovered.id,
        eventType: "export_full_source_fallback_requested" } })).toBe(1);
      if (first.ok) await prisma.exportJob.update({ where: { id: first.exportJobId }, data: { state: "CANCELED" } });
    });
  });

  it("refuses an unrecorded original export and meters an explicit fallback through the worker", async () => {
    const f = await fixture();
    await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { width: 96, height: 64, durationS: 2 } });
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
      "testsrc2=s=96x64:d=2:r=25", "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=2",
      "-c:v", "libx264", "-threads", "1", "-c:a", "aac", "-f", "mp4", provider.absolutePath(f.source.storageKey!)], { timeout: 30000 });
    const sourceBytes = (await fileIdentity(provider.absolutePath(f.source.storageKey!))).byteCount;
    const clip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 400, endMs: 1200, title: "Fallback fixture", summary: "Generated media" } });
    const legacy = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 2, startMs: 400, endMs: 1200, title: "Legacy fixture", summary: "Generated media" } });
    const unrecorded = await prisma.exportJob.create({ data: { workspaceId: f.workspace.id, clipId: legacy.id,
      editVersion: 0, filename: "legacy.mp4", idempotencyKey: randomUUID(), state: "RUNNING", attempt: 1 } });
    await withExportSwitches("true", "true", async () => {
      const downloads = provider.downloadKeys.length;
      await expect(runExportJob(prisma, unrecorded)).rejects.toMatchObject({ code: "FULL_SOURCE_FALLBACK_REQUIRED", terminal: true });
      expect(provider.downloadKeys).toHaveLength(downloads);
      await prisma.exportJob.update({ where: { id: unrecorded.id }, data: { state: "CANCELED" } });
      const queued = await enqueueFullSourceFallbackExport(prisma, { workspaceId: f.workspace.id, clipId: clip.id,
        requestedByUserId: f.workspace.ownerId, filename: "fallback.mp4", editVersion: 0,
        reason: "Fixture: generated source without candidate ranges.", priority: 2147483647 });
      const claimed = await claimNextExportJob(prisma);
      expect(claimed?.id).toBe(queued.job.id);
      const outputId = await runExportJob(prisma, claimed!);
      expect(await markExportJobSucceeded(prisma, claimed!.id, outputId)).toBe(true);
      expect(await prisma.exportJob.findUniqueOrThrow({ where: { id: queued.job.id } })).toMatchObject({ state: "SUCCEEDED",
        qcStatus: "PASSED", qcDetails: { mediaInput: { kind: "ORIGINAL", fullSourceFallbackId: queued.fallback.id,
          editorialExceptionId: queued.exception.id, sourceInterval: { startMs: 400, endMs: 1200 } } } });
      const facts = (await prisma.operationalEvent.findMany({ where: { exportJobId: queued.job.id, eventType: "processing_cost_fact" } }))
        .map(event => event.metadata as Prisma.JsonObject);
      expect(facts.map(fact => fact.stage).sort()).toEqual(["download", "render", "upload"]);
      for (const fact of facts) expect(fact.details).toEqual({ exportInput: "FULL_SOURCE_FALLBACK",
        fullSourceFallbackId: queued.fallback.id, editorialExceptionId: queued.exception.id });
      expect(facts.find(fact => fact.stage === "download")).toMatchObject({ bytes: sourceBytes, outcome: "succeeded" });
      // Completion does not resolve the exception. A person must review the fallback.
      expect(await prisma.editorialException.findUniqueOrThrow({ where: { id: queued.exception.id } })).toMatchObject({ state: "OPEN" });
    });
  }, 60000);

  async function earlyDeletionFixture() {
    const f = await readableRange();
    await withMaterializedSource(prisma, provider, f.request, async source => {
      const base = await artifactInput(source.sourceVideoId, source.sourcePath);
      const identity = { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256, kind: "SOURCE_PROXY" as const,
        sourceInterval: { startMs: 0, endMs: 1000 }, derivationVersion: "analysis-audio-proxy-v2", configurationSha256: base.configurationSha256 };
      // Protocol fixture: these bytes are not a real proxy and carry no playback approval.
      await publishMediaArtifact(prisma, provider, { workspaceId: f.workspace.id, sessionId: source.sessionId, ownerId: f.request.ownerId },
        { ...base, ...identity, storageKey: `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.mp4` },
        source.sourcePath);
    });
    await prisma.project.update({ where: { id: f.project.id }, data: { expiresAt: new Date(Date.now() + 30 * 86400000) } });
    // The base fixture's CLEANUP row would otherwise count as unfinished processing work.
    await prisma.processingJob.update({ where: { id: f.job.id }, data: { state: "SUCCEEDED" } });
    const clip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 100, endMs: 900, title: "Covered candidate", summary: "Local fixture" } });
    return { ...f, clip, attempt: () => attemptEarlyOriginalDeletion(prisma, { workspaceId: f.workspace.id, sourceVideoId: f.source.id }) };
  }

  async function withEarlySwitches<T>(values: Record<string, string | undefined>, work: () => Promise<T>) {
    const keys = ["P4_EARLY_ORIGINAL_DELETION_ENABLED", "P4_RANGE_EXPORTS_ENABLED", "P4_SERMON_PREPARATION_ENABLED",
      "P4_FULL_SOURCE_EXPORT_FALLBACK_ENABLED", "SOURCE_RETENTION_DELETION_ENABLED"];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const set = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    for (const key of keys) set(key, key in values ? values[key] : "true");
    try { return await work(); } finally { for (const key of keys) set(key, previous[key]); }
  }

  it("deletes only the original early after every retained candidate has approved range coverage", async () => {
    const f = await earlyDeletionFixture();
    const key = f.source.storageKey!;
    await withEarlySwitches({ P4_EARLY_ORIGINAL_DELETION_ENABLED: undefined }, async () =>
      expect(await f.attempt()).toMatchObject({ status: "REFUSED", reason: "early_deletion_disabled" }));
    await withEarlySwitches({ P4_RANGE_EXPORTS_ENABLED: undefined }, async () =>
      expect(await f.attempt()).toMatchObject({ status: "REFUSED", reason: "range_exports_disabled" }));
    await withEarlySwitches({ P4_SERMON_PREPARATION_ENABLED: undefined }, async () =>
      expect(await f.attempt()).toMatchObject({ status: "REFUSED", reason: "proxy_playback_disabled" }));
    await withEarlySwitches({}, async () => {
      const expiresAt = (await prisma.project.findUniqueOrThrow({ where: { id: f.project.id } })).expiresAt;
      await prisma.project.update({ where: { id: f.project.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await f.attempt()).toMatchObject({ reason: "fallback_date_reached" });
      await prisma.project.update({ where: { id: f.project.id }, data: { expiresAt: null } });
      expect(await f.attempt()).toMatchObject({ reason: "project_without_retention_date" });
      await prisma.project.update({ where: { id: f.project.id }, data: { expiresAt } });

      const uncovered = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
        rank: 2, startMs: 2000, endMs: 3000, title: "Uncovered reserve", summary: "Local fixture" } });
      expect(await f.attempt()).toMatchObject({ reason: "candidate_range_missing", detail: { clipId: uncovered.id } });
      await prisma.generatedClip.update({ where: { id: uncovered.id }, data: { status: "SUPERSEDED" } });
      const slot = await prisma.scheduledPost.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
        clipId: uncovered.id, scheduledDate: new Date("2026-11-01") } });
      expect(await f.attempt()).toMatchObject({ reason: "candidate_range_missing", detail: { clipId: uncovered.id } });
      await prisma.scheduledPost.update({ where: { id: slot.id }, data: { publishStatus: "SUCCEEDED" } });

      // A covered candidate edited outside its range loses coverage.
      await prisma.clipEdit.create({ data: { clipId: f.clip.id, version: 1,
        editorState: buildDefaultEditorState({ sourceVideoId: f.source.id, startMs: 100, endMs: 1500 }) as never } });
      expect(await f.attempt()).toMatchObject({ reason: "candidate_range_missing", detail: { clipId: f.clip.id, editVersion: 1 } });
      await prisma.clipEdit.create({ data: { clipId: f.clip.id, version: 2,
        editorState: buildDefaultEditorState({ sourceVideoId: f.source.id, startMs: 150, endMs: 850 }) as never } });

      const exportJob = await prisma.exportJob.create({ data: { workspaceId: f.workspace.id, clipId: f.clip.id,
        filename: "queued.mp4", editVersion: 2, idempotencyKey: randomUUID() } });
      expect(await f.attempt()).toMatchObject({ reason: "unfinished_export", detail: { exportJobId: exportJob.id } });
      await prisma.exportJob.update({ where: { id: exportJob.id }, data: { state: "CANCELED" } });

      const fallbackClip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
        rank: 3, startMs: 4000, endMs: 5000, title: "Fallback", summary: "Local fixture" } });
      const fallback = await enqueueFullSourceFallbackExport(prisma, { workspaceId: f.workspace.id, clipId: fallbackClip.id,
        requestedByUserId: f.workspace.ownerId, filename: "fallback.mp4", editVersion: 0, reason: "Fixture fallback." });
      await prisma.exportJob.update({ where: { id: fallback.job.id }, data: { state: "CANCELED" } });
      await prisma.generatedClip.update({ where: { id: fallbackClip.id }, data: { status: "SUPERSEDED" } });
      expect(await f.attempt()).toMatchObject({ reason: "open_full_source_fallback" });
      await prisma.editorialException.update({ where: { id: fallback.exception.id }, data: { state: "RESOLVED" } });

      const processing = await prisma.processingJob.create({ data: { projectId: f.project.id, type: "ANALYZE", idempotencyKey: randomUUID() } });
      expect(await f.attempt()).toMatchObject({ reason: "unfinished_processing_job" });
      await prisma.processingJob.update({ where: { id: processing.id }, data: { state: "CANCELED" } });

      // A later rejection withdraws the earlier acceptance.
      await recordArtifactReview(prisma, { ...f.reviewInput, expectedRevision: 1, decision: "REJECTED" });
      expect(await f.attempt()).toMatchObject({ reason: "candidate_range_missing" });
      await recordArtifactReview(prisma, { ...f.reviewInput, expectedRevision: 2 });

      await withEarlySwitches({ SOURCE_RETENTION_DELETION_ENABLED: undefined }, async () =>
        expect(await f.attempt()).toMatchObject({ status: "REPORT_ONLY", candidateCount: 1 }));
      expect(await provider.exists(key)).toBe(true);
      expect(await prisma.sourceVideo.findUniqueOrThrow({ where: { id: f.source.id } })).toMatchObject({ storageKey: key });

      // The CLEANUP job for an active project runs the same proof.
      await prisma.processingJob.update({ where: { id: f.job.id }, data: { state: "RUNNING" } });
      const result = await runCleanupJob({ job: await prisma.processingJob.findUniqueOrThrow({ where: { id: f.job.id } }), prisma } as never);
      expect(result && result.metadata).toMatchObject({ projectExpired: false, earlyOriginalDeletion: "DELETED", sourceMediaPurged: false });
      expect(await provider.exists(key)).toBe(false);
      expect(await prisma.sourceVideo.findUniqueOrThrow({ where: { id: f.source.id } })).toMatchObject({ storageKey: null });
      const [event] = await prisma.operationalEvent.findMany({ where: { eventType: "early_original_deleted", projectId: f.project.id } });
      expect(event.metadata).toMatchObject({ proof: { storageKey: key, sourceSha256: f.artifact.sourceSha256,
        candidates: [{ clipId: f.clip.id, editVersion: 2, startMs: 150, endMs: 850, artifactId: f.artifact.id }] } });
      for (const artifact of await prisma.derivedMediaArtifact.findMany({ where: { sourceVideoId: f.source.id } })) {
        expect(await provider.exists(artifact.storageKey)).toBe(true);
      }
      // Range exports still work. A fallback can no longer read the original.
      const rangeJob = await enqueueExportJob(prisma, { workspaceId: f.workspace.id, clipId: f.clip.id, filename: "after.mp4", editVersion: 2 });
      expect(await prisma.exportRangeInput.findUnique({ where: { exportJobId: rangeJob.id } })).toMatchObject({ artifactId: f.artifact.id });
      await prisma.exportJob.update({ where: { id: rangeJob.id }, data: { state: "CANCELED" } });
      const late = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
        rank: 4, startMs: 6000, endMs: 7000, title: "Late", summary: "Local fixture" } });
      await expect(enqueueFullSourceFallbackExport(prisma, { workspaceId: f.workspace.id, clipId: late.id,
        requestedByUserId: f.workspace.ownerId, filename: "late.mp4", editVersion: 0, reason: "Too late." }))
        .rejects.toThrow("FULL_SOURCE_FALLBACK_ORIGINAL_UNAVAILABLE");
      expect(await f.attempt()).toMatchObject({ reason: "original_absent" });
    });
  });

  it.each(["export", "edit"] as const)("waits for a concurrent %s writer and then refuses deletion", async writer => {
    const f = await earlyDeletionFixture();
    await withEarlySwitches({}, async () => {
      let release!: () => void;
      let entered!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const locked = new Promise<void>(resolve => { entered = resolve; });
      const writing = secondClient.$transaction(async tx => {
        if (writer === "export") {
          // A range producer takes the source lock before it creates the job.
          await lockMediaSource(tx, f.workspace.id, f.source.id);
          await tx.exportJob.create({ data: { workspaceId: f.workspace.id, clipId: f.clip.id, filename: "race.mp4",
            editVersion: 0, idempotencyKey: randomUUID() } });
        } else {
          // An edit takes no source lock. Its foreign-key lock on the clip still blocks the deletion's row lock.
          await tx.clipEdit.create({ data: { clipId: f.clip.id, version: 1,
            editorState: buildDefaultEditorState({ sourceVideoId: f.source.id, startMs: 100, endMs: 1500 }) as never } });
        }
        entered();
        await hold;
      }, { timeout: 30000 });
      await locked;
      const deletion = f.attempt();
      const settled = await Promise.race([deletion.then(() => "settled"), new Promise(resolve => setTimeout(() => resolve("waiting"), 500))]);
      expect(settled).toBe("waiting");
      release();
      await writing;
      expect(await deletion).toMatchObject({ status: "REFUSED",
        reason: writer === "export" ? "unfinished_export" : "candidate_range_missing" });
      expect(await provider.exists(f.source.storageKey!)).toBe(true);
      if (writer === "export") await prisma.exportJob.updateMany({ where: { clipId: f.clip.id }, data: { state: "CANCELED" } });
    });
  });

  it("renders final range exports only for scheduled candidates, never for reserves", async () => {
    const f = await readableRange();
    const clips = await Promise.all([1, 2, 3].map(rank => prisma.generatedClip.create({ data: { workspaceId: f.workspace.id,
      projectId: f.project.id, rank, startMs: 100 * rank, endMs: 100 * rank + 500, title: `Candidate ${rank}`, summary: "Local fixture" } })));
    const [scheduled, reserveA, reserveB] = clips;
    const slot = await prisma.scheduledPost.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      clipId: scheduled.id, scheduledDate: new Date("2026-11-02") } });
    const census = async () => Object.fromEntries(await Promise.all(clips.map(async clip =>
      [clip.title, await prisma.exportJob.count({ where: { clipId: clip.id } })])));
    expect(await census()).toEqual({ "Candidate 1": 0, "Candidate 2": 0, "Candidate 3": 0 });
    await withExportSwitches("true", undefined, async () => {
      // With automatic publishing off, the coordinator records nothing at all.
      expect(await coordinateScheduledRenders(prisma, { projectId: f.project.id, publishingEnabled: false }))
        .toMatchObject({ enabled: false, jobsCreated: 0 });
      expect(await census()).toEqual({ "Candidate 1": 0, "Candidate 2": 0, "Candidate 3": 0 });
      const first = await coordinateScheduledRenders(prisma, { projectId: f.project.id, publishingEnabled: true });
      expect(first).toMatchObject({ enabled: true, slotsBound: 1, jobsCreated: 1, failures: [] });
      const again = await coordinateScheduledRenders(prisma, { projectId: f.project.id, publishingEnabled: true });
      expect(again).toMatchObject({ slotsScanned: 0, jobsCreated: 0 });
      expect(await census()).toEqual({ "Candidate 1": 1, "Candidate 2": 0, "Candidate 3": 0 });
      const job = await prisma.exportJob.findFirstOrThrow({ where: { clipId: scheduled.id } });
      expect(await prisma.exportRangeInput.findUnique({ where: { exportJobId: job.id } })).toMatchObject({ artifactId: f.artifact.id });
      expect(await prisma.scheduledPost.findUniqueOrThrow({ where: { id: slot.id } })).toMatchObject({ exportJobId: job.id });
      for (const reserve of [reserveA, reserveB]) {
        expect(await assessFinalRender(prisma, { clipId: reserve.id }, { publishingEnabled: true }))
          .toMatchObject({ allowed: false, reason: "UNSCHEDULED_RESERVE" });
      }
      // A promoted reserve is bound to the slot first, and only then rendered.
      await prisma.exportJob.update({ where: { id: job.id }, data: { state: "CANCELED" } });
      await prisma.scheduledPost.update({ where: { id: slot.id }, data: { clipId: reserveA.id, exportJobId: null } });
      expect(await assessFinalRender(prisma, { clipId: reserveA.id }, { publishingEnabled: true })).toMatchObject({ allowed: true });
      expect(await coordinateScheduledRenders(prisma, { projectId: f.project.id, publishingEnabled: true }))
        .toMatchObject({ slotsBound: 1, jobsCreated: 1 });
      expect(await census()).toEqual({ "Candidate 1": 1, "Candidate 2": 1, "Candidate 3": 0 });
      await prisma.exportJob.updateMany({ where: { clipId: { in: clips.map(clip => clip.id) }, state: "QUEUED" }, data: { state: "CANCELED" } });
    });
  });

  it("retains expired ranges for unfinished pinned exports and releases them after completion", async () => {
    const f = await queuedRangePin();
    await prisma.derivedMediaArtifact.update({ where: { id: f.artifact.id }, data: { expiresAt: new Date("2020-01-01") } });
    const cleanup = { workspaceId: f.workspace.id, sourceVideoId: f.source.id, ownerId: randomUUID(), maxArtifacts: 10 };
    for (const state of ["QUEUED", "WAITING", "RETRYING", "RUNNING"] as const) {
      await prisma.exportJob.update({ where: { id: f.job.id }, data: { state } });
      expect((await cleanupExpiredMediaArtifacts(prisma, provider, cleanup)).deletedArtifactIds).toEqual([]);
      expect(await provider.exists(f.artifact.storageKey)).toBe(true);
    }
    await expect(withMaterializedRange(prisma, provider, f.readRequest, async () => {})).rejects.toThrow("NOT_APPROVED_OR_COVERED");
    await expect(withMaterializedRange(prisma, provider, { ...f.readRequest, exportJobId: randomUUID() }, async () => {}))
      .rejects.toThrow("EXPORT_PIN_CHANGED");
    const read = { ...f.readRequest, exportJobId: f.job.id };
    const bytes = await withMaterializedRange(prisma, provider, read, async range => {
      expect(range.retentionHeldByExportJobId).toBe(f.job.id);
      expect(range.artifact.expiresAt).toEqual(new Date("2020-01-01"));
      return (await fileIdentity(range.path)).byteCount;
    });
    expect(bytes).toBe(Number(f.artifact.byteCount));
    await prisma.exportJob.update({ where: { id: f.job.id }, data: { state: "SUCCEEDED" } });
    await expect(withMaterializedRange(prisma, provider, read, async () => {})).rejects.toThrow("EXPORT_PIN_CHANGED");
    expect((await cleanupExpiredMediaArtifacts(prisma, provider, cleanup)).deletedArtifactIds).toEqual([f.artifact.id]);
    expect(await provider.exists(f.artifact.storageKey)).toBe(false);
  });

  it("refuses a pinned export after its exact review changes, even if a later review accepts the bytes", async () => {
    const f = await queuedRangePin();
    await prisma.exportJob.update({ where: { id: f.job.id }, data: { state: "RUNNING" } });
    await recordArtifactReview(prisma, { ...f.reviewInput, expectedRevision: 1 });
    const before = provider.downloads;
    await expect(withMaterializedRange(prisma, provider, { ...f.readRequest, exportJobId: f.job.id }, async () => {}))
      .rejects.toThrow("EXPORT_PIN_CHANGED");
    expect(provider.downloads).toBe(before);
  });

  it("pins a queued export to its saved interval, exact artifact, and review", async () => {
    const f = await readableRange();
    const clip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 100, endMs: 900, title: "Pin fixture", summary: "Local pin fixture" } });
    // Earlier tests leave queued pinned jobs. Top priority makes the activated claim select this job.
    const job = await prisma.exportJob.create({ data: { workspaceId: f.workspace.id, clipId: clip.id,
      filename: "fixture.mp4", editVersion: 0, idempotencyKey: `export:${clip.id}:v0`, priority: 2147483647 } });
    const input = { workspaceId: f.workspace.id, exportJobId: job.id, artifactId: f.artifact.id };
    const pinned = await prepareExportRangeInput(prisma, input);
    expect(pinned).toMatchObject({ exportJobId: job.id, artifactId: f.artifact.id, sourceVideoId: f.source.id,
      artifactSha256: f.artifact.sha256, mappingEvidenceSha256: f.artifact.mappingEvidenceSha256,
      editVersion: 0, startMs: BigInt(100), endMs: BigInt(900) });
    expect(await prepareExportRangeInput(prisma, input)).toEqual(pinned);
    expect(await claimNextExportJob(prisma)).toBeNull();
    await expect(prepareExportRangeInput(prisma, { ...input, artifactId: randomUUID() })).rejects.toThrow("INPUT_CONFLICT");
    await expect(prisma.exportRangeInput.update({ where: { exportJobId: job.id }, data: { startMs: BigInt(101) } }))
      .rejects.toThrow("INPUT_IMMUTABLE");
    await expect(prisma.exportRangeInput.delete({ where: { exportJobId: job.id } })).rejects.toThrow("INPUT_IMMUTABLE");
    expect((await prisma.mediaArtifactReview.findUniqueOrThrow({ where: { id: pinned.reviewId } })).decision).toBe("ACCEPTED");
    const previousActivation = process.env.P4_RANGE_EXPORTS_ENABLED;
    process.env.P4_RANGE_EXPORTS_ENABLED = "true";
    try { expect(await claimNextExportJob(prisma)).toMatchObject({ id: job.id, state: "RUNNING", attempt: 1 }); }
    finally {
      if (previousActivation === undefined) delete process.env.P4_RANGE_EXPORTS_ENABLED;
      else process.env.P4_RANGE_EXPORTS_ENABLED = previousActivation;
    }
  });

  it("refuses range pins for started jobs, other workspaces, and uncovered saved intervals", async () => {
    const f = await readableRange();
    const clip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 100, endMs: 1001, title: "Uncovered pin", summary: "Local fixture" } });
    const job = await prisma.exportJob.create({ data: { workspaceId: f.workspace.id, clipId: clip.id,
      filename: "fixture.mp4", editVersion: 0, idempotencyKey: `export:${clip.id}:v0` } });
    const input = { workspaceId: f.workspace.id, exportJobId: job.id, artifactId: f.artifact.id };
    await expect(prepareExportRangeInput(prisma, { ...input, workspaceId: randomUUID() })).rejects.toThrow("JOB_NOT_FOUND");
    await expect(prepareExportRangeInput(prisma, input)).rejects.toThrow("NOT_APPROVED_OR_COVERED");
    await prisma.exportJob.update({ where: { id: job.id }, data: { state: "RUNNING", attempt: 1 } });
    await expect(prepareExportRangeInput(prisma, input)).rejects.toThrow("ALREADY_STARTED");
    expect(await prisma.exportRangeInput.count({ where: { exportJobId: job.id } })).toBe(0);
  });

  it("requires immutable, authorized review evidence and rejects stale or concurrent decisions", async () => {
    const f = await readableRange();
    await expect(recordArtifactReview(prisma, { ...f.reviewInput, expectedRevision: 1, reviewerId: randomUUID() }))
      .rejects.toThrow("NOT_AUTHORIZED");
    await expect(recordArtifactReview(prisma, f.reviewInput)).rejects.toThrow("REVISION_CHANGED");
    await expect(recordArtifactReview(prisma, { ...f.reviewInput, expectedRevision: 1, artifactSha256: "0".repeat(64) }))
      .rejects.toThrow("BYTES_CHANGED");
    await expect(recordArtifactReview(prisma, { ...f.reviewInput, expectedRevision: 1,
      evidence: { ...f.reviewInput.evidence, fullRangeCompared: false } })).rejects.toThrow("INCOMPLETE");
    const review = await prisma.mediaArtifactReview.findFirstOrThrow({ where: { artifactId: f.artifact.id } });
    await expect(prisma.mediaArtifactReview.update({ where: { id: review.id }, data: { decision: "REJECTED" } }))
      .rejects.toThrow("REVIEW_IMMUTABLE");
    await expect(prisma.derivedMediaArtifact.update({ where: { id: f.artifact.id }, data: { visualQuality: "REJECTED" } }))
      .rejects.toThrow("REVIEW_REQUIRED");
    await withMaterializedRange(prisma, provider, f.readRequest, async () => {
      await expect(recordArtifactReview(secondClient, { ...f.reviewInput, expectedRevision: 1, decision: "REJECTED" }))
        .rejects.toThrow("SESSION_UNFINISHED");
    });
    const rejected = await recordArtifactReview(prisma, { ...f.reviewInput, expectedRevision: 1, decision: "REJECTED" });
    expect(rejected.revision).toBe(2);
    expect(await prisma.mediaArtifactReview.count({ where: { artifactId: f.artifact.id } })).toBe(2);
    await expect(withMaterializedRange(prisma, provider, f.readRequest, async () => {})).rejects.toThrow("NOT_APPROVED_OR_COVERED");
  });

  it("pins a range against cleanup and reads no original, including when the original is absent", async () => {
    const f = await readableRange();
    await provider.remove(f.source.storageKey!);
    await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { storageKey: null } });
    const before = provider.downloadKeys.length;
    let sessionId = "";
    const value = await withMaterializedRange(prisma, provider, f.readRequest, async range => {
      sessionId = range.sessionId;
      expect(await fileIdentity(range.path)).toEqual({ sha256: f.artifact.sha256, byteCount: Number(f.artifact.byteCount) });
      expect(range).toMatchObject({ sourceWidth: 1920, sourceHeight: 1080 });
      await prisma.derivedMediaArtifact.update({ where: { id: f.artifact.id }, data: { expiresAt: new Date("2020-01-01") } });
      await expect(cleanupExpiredMediaArtifacts(secondClient, provider, { workspaceId: f.workspace.id, sourceVideoId: f.source.id,
        ownerId: randomUUID(), maxArtifacts: 10 })).rejects.toThrow("SESSION_UNFINISHED");
      await expect(withMaterializedRange(secondClient, provider, { ...f.readRequest, ownerId: randomUUID() }, async () => {}))
        .rejects.toThrow("SESSION_UNFINISHED");
      return "range consumed";
    });
    expect(value).toBe("range consumed");
    expect(provider.downloadKeys.slice(before)).toEqual([f.artifact.storageKey]);
    expect(await readdir(f.request.temporaryRoot)).toEqual([]);
    expect(await prisma.sourceMediaSession.findUnique({ where: { id: sessionId } })).toMatchObject({ purpose: "P4_RANGE_RENDER", state: "COMPLETE" });
    await cleanupExpiredMediaArtifacts(prisma, provider, { workspaceId: f.workspace.id, sourceVideoId: f.source.id, ownerId: randomUUID(), maxArtifacts: 10 });
    expect(await provider.exists(f.artifact.storageKey)).toBe(false);
  });

  it("refuses wrong ownership and uncovered ranges before downloading", async () => {
    const f = await readableRange();
    const before = provider.downloads;
    await expect(withMaterializedRange(prisma, provider, { ...f.readRequest, workspaceId: randomUUID() }, async () => {})).rejects.toThrow("SOURCE_NOT_FOUND");
    await expect(withMaterializedRange(prisma, provider, { ...f.readRequest, sourceRange: { startMs: 0, endMs: 1001 } }, async () => {}))
      .rejects.toThrow("NOT_APPROVED_OR_COVERED");
    await recordArtifactReview(prisma, { ...f.reviewInput, expectedRevision: 1, decision: "REJECTED" });
    await expect(withMaterializedRange(prisma, provider, f.readRequest, async () => {})).rejects.toThrow("NOT_APPROVED_OR_COVERED");
    expect(provider.downloads).toBe(before);
  });

  it("settles failed acquisition and leaves failed range callbacks uncertain", async () => {
    const f = await readableRange();
    provider.fail = true;
    try {
      await expect(withMaterializedRange(prisma, provider, f.readRequest, async () => { throw new Error("must not run"); }))
        .rejects.toThrow("Fixture acquisition failure");
    } finally { provider.fail = false; }
    expect(await prisma.sourceMediaSession.findFirst({ where: { sourceId: f.source.id, purpose: "P4_RANGE_RENDER" } }))
      .toMatchObject({ state: "COMPLETE", terminalEvidence: { callbackStarted: false, temporaryFilesRemoved: true } });
    await expect(withMaterializedRange(prisma, provider, f.readRequest, async () => { throw new Error("render interrupted"); }))
      .rejects.toThrow("render interrupted");
    expect(await prisma.sourceMediaSession.findFirst({ where: { sourceId: f.source.id, state: "UNCERTAIN" } }))
      .toMatchObject({ purpose: "P4_RANGE_RENDER", terminalEvidence: { callbackStarted: true, callbackSucceeded: false } });
    expect(await readdir(f.request.temporaryRoot)).toEqual([]);
    await expect(withMaterializedRange(prisma, provider, f.readRequest, async () => {})).rejects.toThrow("SESSION_UNFINISHED");
  });

  async function expiredArtifact() {
    const f = await fixture();
    let record!: ArtifactRecord;
    let artifactId = "";
    await withMaterializedSource(prisma, provider, f.request, async source => {
      record = await artifactInput(source.sourceVideoId, source.sourcePath);
      const identity = artifactIdentityKey({ sourceVideoId: record.sourceVideoId, sourceSha256: record.sourceSha256,
        kind: record.kind, sourceInterval: record.sourceInterval, derivationVersion: record.derivationVersion,
        configurationSha256: record.configurationSha256 });
      record.storageKey = `sources/${source.sourceVideoId}/artifacts/${identity}.flac`;
      record.expiresAt = new Date("2020-01-01");
      artifactId = (await publishMediaArtifact(prisma, provider, { workspaceId: f.workspace.id,
        ownerId: f.request.ownerId, sessionId: source.sessionId }, record, source.sourcePath)).artifact.id;
    });
    return { ...f, record, artifactId, cleanup: { workspaceId: f.workspace.id, sourceVideoId: f.source.id,
      ownerId: randomUUID(), maxArtifacts: 10 } };
  }

  it("journals artifact deletion before storage work and retains source media and history", async () => {
    const f = await expiredArtifact();
    const checked = Object.create(provider) as LocalDiskStorageProvider;
    checked.remove = async key => {
      const session = await secondClient.sourceMediaSession.findFirstOrThrow({ where: {
        sourceId: f.source.id, purpose: "P4_ARTIFACT_CLEANUP", state: "ACTIVE" } });
      expect(await secondClient.cleanupAuditEvent.findFirst({ where: { targetId: session.id, action: "ACTIVE" } }))
        .toMatchObject({ evidence: { artifacts: [{ id: f.artifactId, storageKey: key, sha256: f.record.sha256 }] } });
      await provider.remove(key);
    };
    const result = await cleanupExpiredMediaArtifacts(prisma, checked, f.cleanup);
    expect(result.deletedArtifactIds).toEqual([f.artifactId]);
    expect(await provider.exists(f.record.storageKey)).toBe(false);
    expect(await provider.exists(f.source.storageKey!)).toBe(true);
    expect(await prisma.derivedMediaArtifact.findUnique({ where: { id: f.artifactId } }))
      .toMatchObject({ deletedAt: expect.any(Date), deletionEvidence: { cleanupSessionId: result.sessionId, absentBeforeDelete: false } });
    expect(await prisma.sourceMediaSession.findUnique({ where: { id: result.sessionId! } })).toMatchObject({ state: "COMPLETE" });
    expect(await cleanupExpiredMediaArtifacts(prisma, provider, f.cleanup)).toEqual({ sessionId: null, deletedArtifactIds: [] });
  });

  it("keeps artifacts for active projects or extended artifact retention", async () => {
    const f = await expiredArtifact();
    await prisma.project.update({ where: { id: f.project.id }, data: { expiresAt: null } });
    expect((await cleanupExpiredMediaArtifacts(prisma, provider, f.cleanup)).sessionId).toBeNull();
    await prisma.project.update({ where: { id: f.project.id }, data: { expiresAt: new Date("2020-01-01") } });
    await prisma.derivedMediaArtifact.update({ where: { id: f.artifactId }, data: { expiresAt: new Date("2099-01-01") } });
    expect((await cleanupExpiredMediaArtifacts(prisma, provider, f.cleanup)).sessionId).toBeNull();
    expect(await provider.exists(f.record.storageKey)).toBe(true);
    await expect(cleanupExpiredMediaArtifacts(prisma, provider, { ...f.cleanup, workspaceId: randomUUID() }))
      .rejects.toThrow("MEDIA_SOURCE_NOT_FOUND");
  });

  it("refuses an empty wrong storage root instead of treating it as deletion evidence", async () => {
    const f = await expiredArtifact();
    const wrong = new LocalDiskStorageProvider(path.join(root, "wrong-storage"));
    await expect(cleanupExpiredMediaArtifacts(prisma, wrong, f.cleanup)).rejects.toThrow("MEDIA_CLEANUP_STORAGE_LOCATION_CHANGED");
    expect(await prisma.derivedMediaArtifact.findUnique({ where: { id: f.artifactId } })).toMatchObject({ deletedAt: null });
    expect(await provider.exists(f.record.storageKey)).toBe(true);
    expect(await prisma.sourceMediaSession.count({ where: { sourceId: f.source.id, purpose: "P4_ARTIFACT_CLEANUP" } })).toBe(0);
  });

  it("keeps changed artifact bytes and blocks new work after uncertain cleanup", async () => {
    const f = await expiredArtifact();
    await chmod(provider.absolutePath(f.record.storageKey), 0o600);
    await writeFile(provider.absolutePath(f.record.storageKey), "changed bytes");
    await expect(cleanupExpiredMediaArtifacts(prisma, provider, f.cleanup)).rejects.toThrow("MEDIA_CLEANUP_OBJECT_CHANGED");
    expect(await provider.readAsBuffer(f.record.storageKey)).toEqual(Buffer.from("changed bytes"));
    expect(await prisma.sourceMediaSession.findFirst({ where: { sourceId: f.source.id, purpose: "P4_ARTIFACT_CLEANUP" } }))
      .toMatchObject({ state: "UNCERTAIN" });
    await expect(withMaterializedSource(prisma, provider, f.request, async () => {})).rejects.toBeInstanceOf(SourceMediaBusyError);
    await expect(registerMediaArtifact(prisma, f.workspace.id, f.record)).rejects.toThrow("MEDIA_ARTIFACT_CLEANUP_UNFINISHED");
  });

  it("does not retry deletion when storage removed bytes before reporting a failure", async () => {
    const f = await expiredArtifact();
    const uncertain = Object.create(provider) as LocalDiskStorageProvider;
    uncertain.remove = async key => { await provider.remove(key); throw new Error("fixture response lost"); };
    await expect(cleanupExpiredMediaArtifacts(prisma, uncertain, f.cleanup)).rejects.toThrow("fixture response lost");
    expect(await provider.exists(f.record.storageKey)).toBe(false);
    expect(await prisma.derivedMediaArtifact.findUnique({ where: { id: f.artifactId } })).toMatchObject({ deletedAt: null });
    await expect(cleanupExpiredMediaArtifacts(prisma, provider, f.cleanup)).rejects.toThrow("MEDIA_SOURCE_SESSION_UNFINISHED");
  });

  it("requires observed absence and refuses cleanup during an active source batch", async () => {
    const f = await expiredArtifact();
    await withMaterializedSource(prisma, provider, f.request, async () => {
      await expect(cleanupExpiredMediaArtifacts(prisma, provider, f.cleanup)).rejects.toThrow("MEDIA_SOURCE_SESSION_UNFINISHED");
    });
    const ineffective = Object.create(provider) as LocalDiskStorageProvider;
    ineffective.remove = async () => {};
    await expect(cleanupExpiredMediaArtifacts(prisma, ineffective, f.cleanup)).rejects.toThrow("MEDIA_CLEANUP_ABSENCE_UNCONFIRMED");
    expect(await prisma.derivedMediaArtifact.findUnique({ where: { id: f.artifactId } })).toMatchObject({ deletedAt: null });
  });

  it("reserves cleanup ownership before upload and publishes only verified bytes", async () => {
    const f = await fixture();
    let artifactId = "";
    await withMaterializedSource(prisma, provider, f.request, async source => {
      const input = await artifactInput(source.sourceVideoId, source.sourcePath);
      const owner = { workspaceId: f.workspace.id, ownerId: f.request.ownerId, sessionId: source.sessionId };
      const checked = Object.create(provider) as LocalDiskStorageProvider;
      checked.uploadFileIfAbsent = async (key, file) => {
        const row = await secondClient.derivedMediaArtifact.findUniqueOrThrow({ where: { storageKey: key } });
        expect(row).toMatchObject({ publicationState: "PENDING", publicationSessionId: source.sessionId, publicationEvidence: null });
        await provider.uploadFileIfAbsent(key, file);
      };
      const result = await publishMediaArtifact(prisma, checked, owner, input, source.sourcePath);
      artifactId = result.artifact.id;
      expect(result.artifact).toMatchObject({ publicationState: "READY", mappingStatus: "DECLARED",
        publicationEvidence: { sha256: input.sha256, byteCount: input.byteCount.toString() } });
      expect((await publishMediaArtifact(prisma, checked, owner, input, source.sourcePath)).artifact.id).toBe(artifactId);
      expect(await provider.readAsBuffer(input.storageKey)).toEqual(await readFile(source.sourcePath));
      await expect(prisma.derivedMediaArtifact.update({ where: { id: artifactId }, data: {
        publicationState: "PENDING", publicationEvidence: Prisma.DbNull,
      } })).rejects.toThrow("MEDIA_ARTIFACT_PUBLICATION_IMMUTABLE");
    });
    expect(await prisma.derivedMediaArtifact.findUnique({ where: { id: artifactId } })).toMatchObject({ publicationState: "READY" });
  });

  it("refuses a changed ready object without overwriting it or changing its publication proof", async () => {
    const f = await fixture();
    let input!: ArtifactRecord;
    await withMaterializedSource(prisma, provider, f.request, async source => {
      input = await artifactInput(source.sourceVideoId, source.sourcePath);
      await publishMediaArtifact(prisma, provider, { workspaceId: f.workspace.id,
        ownerId: f.request.ownerId, sessionId: source.sessionId }, input, source.sourcePath);
    });
    const before = await prisma.derivedMediaArtifact.findUniqueOrThrow({ where: { storageKey: input.storageKey } });
    const corrupt = Buffer.alloc(Number(input.byteCount), 120);
    await chmod(provider.absolutePath(input.storageKey), 0o600);
    await writeFile(provider.absolutePath(input.storageKey), corrupt);
    const uploads = provider.uploads;
    await withMaterializedSource(prisma, provider, f.request, async source => {
      await expect(publishMediaArtifact(prisma, provider, { workspaceId: f.workspace.id,
        ownerId: f.request.ownerId, sessionId: source.sessionId }, input, source.sourcePath))
        .rejects.toThrow("MEDIA_PUBLICATION_STORED_IDENTITY_CHANGED");
    });
    expect(provider.uploads).toBe(uploads);
    expect(await provider.readAsBuffer(input.storageKey)).toEqual(corrupt);
    expect((await prisma.derivedMediaArtifact.findUniqueOrThrow({ where: { id: before.id } })).publicationEvidence)
      .toEqual(before.publicationEvidence);
  });

  it("preserves pending ownership and an uncertain lease after stored checksum failure", async () => {
    const f = await fixture();
    let sessionId = "";
    let key = "";
    await expect(withMaterializedSource(prisma, provider, f.request, async source => {
      sessionId = source.sessionId;
      const input = await artifactInput(source.sourceVideoId, source.sourcePath);
      key = input.storageKey;
      const corrupt = Object.create(provider) as LocalDiskStorageProvider;
      corrupt.uploadFileIfAbsent = async (storageKey, file) => {
        await provider.uploadFileIfAbsent(storageKey, file);
        await chmod(provider.absolutePath(storageKey), 0o600);
        await writeFile(provider.absolutePath(storageKey), Buffer.alloc(Number(input.byteCount), 120));
      };
      await publishMediaArtifact(prisma, corrupt, { workspaceId: f.workspace.id,
        ownerId: f.request.ownerId, sessionId }, input, source.sourcePath);
    })).rejects.toThrow("MEDIA_PUBLICATION_STORED_BYTES_MISMATCH");
    expect(await prisma.derivedMediaArtifact.findUnique({ where: { storageKey: key } }))
      .toMatchObject({ publicationState: "PENDING", publicationEvidence: null, publicationSessionId: sessionId });
    expect(await prisma.sourceMediaSession.findUnique({ where: { id: sessionId } })).toMatchObject({ state: "UNCERTAIN" });
    expect(await provider.exists(key)).toBe(true);
  });

  it("does not complete a lease when the callback catches a publication failure", async () => {
    const f = await fixture();
    let sessionId = "";
    await expect(withMaterializedSource(prisma, provider, f.request, async source => {
      sessionId = source.sessionId;
      const input = await artifactInput(source.sourceVideoId, source.sourcePath);
      const unavailable = Object.create(provider) as LocalDiskStorageProvider;
      unavailable.uploadFileIfAbsent = async () => { throw new Error("fixture storage unavailable"); };
      await expect(publishMediaArtifact(prisma, unavailable, { workspaceId: f.workspace.id,
        ownerId: f.request.ownerId, sessionId }, input, source.sourcePath)).rejects.toThrow("fixture storage unavailable");
    })).rejects.toThrow("MEDIA_SESSION_HAS_PENDING_PUBLICATIONS");
    expect(await prisma.sourceMediaSession.findUnique({ where: { id: sessionId } }))
      .toMatchObject({ state: "UNCERTAIN", terminalEvidence: { pendingPublications: 1 } });
  });

  it("refuses another owner before creating a record or uploading bytes", async () => {
    const f = await fixture();
    await withMaterializedSource(prisma, provider, f.request, async source => {
      const input = await artifactInput(source.sourceVideoId, source.sourcePath);
      await expect(publishMediaArtifact(prisma, provider, { workspaceId: f.workspace.id,
        ownerId: randomUUID(), sessionId: source.sessionId }, input, source.sourcePath))
        .rejects.toThrow("MEDIA_PUBLICATION_OWNER_OR_STATE_CHANGED");
      expect(await prisma.derivedMediaArtifact.findUnique({ where: { storageKey: input.storageKey } })).toBeNull();
      expect(await provider.exists(input.storageKey)).toBe(false);
    });
  });

  it("rejects incomplete publication evidence and cross-source session references in the database", async () => {
    const f = await fixture();
    const other = await fixture();
    await withMaterializedSource(prisma, provider, f.request, async source => {
      const input = await artifactInput(source.sourceVideoId, source.sourcePath);
      const { sourceInterval, ...facts } = input;
      const row = await prisma.derivedMediaArtifact.create({ data: { ...facts, identityKey: "c".repeat(64),
        startMs: BigInt(sourceInterval.startMs), endMs: BigInt(sourceInterval.endMs), publicationSessionId: source.sessionId } });
      await expect(prisma.derivedMediaArtifact.update({ where: { id: row.id }, data: {
        publicationState: "READY", publicationEvidence: { sha256: input.sha256, byteCount: input.byteCount.toString() },
      } })).rejects.toThrow();
      await expect(prisma.derivedMediaArtifact.create({ data: { ...facts, sourceVideoId: other.source.id,
        identityKey: "d".repeat(64), storageKey: randomUUID(), startMs: BigInt(0), endMs: BigInt(1000),
        publicationSessionId: source.sessionId } })).rejects.toThrow();
      // This fixture has no storage writes. Record its deletion evidence for the test-only reservation.
      await prisma.derivedMediaArtifact.update({ where: { id: row.id }, data: {
        deletedAt: new Date(), deletionEvidence: { fixtureOnly: true, storageNeverWritten: true },
      } });
    });
  });

  it("materializes once for a batch and rejects a competing process before its acquisition", async () => {
    const f = await fixture();
    const before = provider.downloads;
    let directory = "";
    let sessionId = "";
    await withMaterializedSource(prisma, provider, f.request, async source => {
      directory = source.directory; sessionId = source.sessionId;
      expect(source).toMatchObject({ width: 1920, height: 1080, transcriptRevision: 0 });
      await expect(withMaterializedSource(secondClient, provider, { ...f.request, ownerId: randomUUID() }, async () => {}))
        .rejects.toBeInstanceOf(SourceMediaBusyError);
      await Promise.all(["audio", "proxy", "frames"].map(async name => {
        const output = path.join(source.directory, name);
        await copyFile(source.sourcePath, output);
        expect(await readFile(output, "utf8")).toBe("source bytes for one project batch");
      }));
    });
    expect(provider.downloads - before).toBe(1);
    await expect(readdir(directory)).rejects.toThrow();
    expect(await prisma.sourceMediaSession.findUnique({ where: { id: sessionId } }))
      .toMatchObject({ state: "COMPLETE", revision: BigInt(1), terminalEvidence: { temporaryFilesRemoved: true, callbackSucceeded: true } });
    expect(await prisma.cleanupAuditEvent.findMany({ where: { targetId: sessionId }, orderBy: { revision: "asc" } }))
      .toMatchObject([{ action: "ACTIVE", revision: BigInt(0) }, { action: "COMPLETE", revision: BigInt(1) }]);
    expect(await prisma.sourceVideo.findUnique({ where: { id: f.source.id } })).toMatchObject({ width: 1920, height: 1080 });
  });

  it("keeps source bytes while the batch runs and permits ordinary retention afterward", async () => {
    const f = await fixture();
    await withMaterializedSource(prisma, provider, f.request, async source => {
      await runCleanupJob({ prisma: secondClient, job: f.job });
      expect(await getStorageProvider().exists(f.source.storageKey!)).toBe(true);
      expect(await readFile(source.sourcePath, "utf8")).toBe("source bytes for one project batch");
      const event = await prisma.operationalEvent.findFirst({ where: { jobId: f.job.id, eventType: "retention_cleanup" } });
      expect(event?.metadata).toMatchObject({ sourcePurgeSkippedReason: "source media has an unfinished session", purgedSourceKeys: [] });
    });
    await runCleanupJob({ prisma, job: f.job });
    expect(await provider.exists(f.source.storageKey!)).toBe(false);
    expect(await prisma.sourceVideo.findUnique({ where: { id: f.source.id } })).toMatchObject({ storageKey: null });
    await expect(withMaterializedSource(prisma, provider, f.request, async () => {})).rejects.toThrow("MEDIA_SOURCE_NOT_RENDERABLE");
  });

  const batchSettings = { proxyCrf: 18, proxyPreset: "ultrafast" as const, proxyAudioBitrateBps: 64000,
    flacCompressionLevel: 5, encoderThreads: 1, timeoutMs: 30000 };
  const batchRetention = { analysisExpiresAt: new Date("2027-01-01"), previewExpiresAt: new Date("2027-02-01") };
  const evidenceSettings = {
    audio: { silenceNoiseDb: -40, silenceMinimumMs: 200, waveformWindowSamples: 1600,
      threads: 1, timeoutMs: 30000, maxMetadataBytes: 1024 * 1024 },
    video: { sceneThreshold: 5, blackPixelThreshold: 0.1, blackPictureRatio: 0.98, blackMinimumMs: 200,
      freezeNoiseRatio: 0.001, freezeMinimumMs: 200, threads: 1, timeoutMs: 30000, maxMetadataBytes: 1024 * 1024 },
    frames: { intervalMs: 500, maxFrames: 100, threads: 1, timeoutMs: 30000, maxOutputBytes: 1024 * 1024 },
    representatives: { quality: 75, threads: 1, maxFrames: 10, maxFrameBytes: 1024 * 1024,
      maxTotalBytes: 10 * 1024 * 1024, maxOutputBytes: 1024 * 1024, timeoutMs: 30000 },
    grouping: { maxHammingDistance: 0, maxMeanLumaDifference: 0, maxSpanMs: 1000 }, maxDocumentBytes: 1024 * 1024,
  };
  async function writeMedia(key: string) {
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
      "color=black:s=1920x1080:d=1:r=25", "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-c:a", "aac", "-shortest",
      "-f", "mp4", provider.absolutePath(key)], { timeout: 30000 });
  }

  it("registers exact candidate ranges and a reusable coverage manifest under one acquisition", async () => {
    const f = await fixture();
    await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { width: 96, height: 64, durationS: 1.001 } });
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
      "testsrc2=s=96x64:d=1.001:r=30000/1001", "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=1.001",
      "-c:v", "libx264", "-threads", "1", "-g", "10", "-bf", "0", "-sc_threshold", "0", "-c:a", "pcm_s16le",
      "-f", "mov", provider.absolutePath(f.source.storageKey!)], { timeout: 30000 });
    const settings = { sourceDurationMs: 1001, sourceOriginMs: 0,
      candidates: [{ candidateId: "first", sourceInterval: { startMs: 334, endMs: 400 } },
        { candidateId: "second", sourceInterval: { startMs: 500, endMs: 600 } }],
      handles: { beforeMs: 0, afterMs: 0 }, expiresAt: new Date("2020-01-01"),
      keyframes: { timeoutMs: 30000, maxOutputBytes: 1024 * 1024, maxPackets: 1000 },
      extraction: { mode: "prefer-stream-copy" as const, threads: 1, timeoutMs: 30000,
        maxOutputBytes: 1024 * 1024, maxFileBytes: 10 * 1024 * 1024, maxProofFrames: 1000 } };
    const result = await runCandidateRangeBatch(prisma, provider, f.request, settings);
    expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(1);
    expect(result.ranges).toHaveLength(1);
    const range = result.ranges[0];
    expect(range.artifact).toMatchObject({ kind: "CANDIDATE_RANGE", publicationState: "READY",
      retentionClass: "RENDER_SOURCE", mappingStatus: "VERIFIED", visualQuality: "NOT_REVIEWED",
      startMs: BigInt(334), endMs: BigInt(667), expiresAt: settings.expiresAt, publicationSessionId: result.sessionId });
    expect(range.mapping).toMatchObject({ sourceInterval: { startMs: 334, endMs: 667 }, artifactOriginMs: 334 });
    expect(range.artifact.publicationEvidence).toMatchObject({ derivation: { extraction: {
      sourceInterval: { startMs: { numerator: "1001", denominator: "3" }, endMs: { numerator: "2002", denominator: "3" } },
      videoFrames: 10, audioSamples: "16016" } } });
    expect(result.manifest.artifact).toMatchObject({ kind: "LOCAL_EVIDENCE", publicationState: "READY", retentionClass: "RENDER_SOURCE" });
    const manifest = JSON.parse((await provider.readAsBuffer(result.manifest.artifact.storageKey)).toString("utf8"));
    expect(manifest.ranges).toEqual([expect.objectContaining({ artifactId: range.artifact.id, candidateIds: ["first", "second"] })]);
    expect(manifest.plan.coverage).toHaveLength(2);
    expect(await fileIdentity(provider.absolutePath(range.artifact.storageKey))).toEqual({ sha256: range.artifact.sha256,
      byteCount: Number(range.artifact.byteCount) });
    expect(await readdir(f.request.temporaryRoot)).toEqual([]);
    const uploads = provider.uploads;
    const repeated = await runCandidateRangeBatch(prisma, provider, f.request, settings);
    expect(repeated.ranges[0].artifact.id).toBe(range.artifact.id);
    expect(repeated.manifest.artifact.id).toBe(result.manifest.artifact.id);
    expect(provider.uploads).toBe(uploads);
    expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(2);
    await cleanupExpiredMediaArtifacts(prisma, provider, { workspaceId: f.workspace.id, sourceVideoId: f.source.id,
      ownerId: randomUUID(), maxArtifacts: 10 });
    expect(await provider.exists(range.artifact.storageKey)).toBe(false);
    expect(await provider.exists(result.manifest.artifact.storageKey)).toBe(false);
    expect(await provider.exists(f.source.storageKey!)).toBe(true);
    expect(await prisma.sourceVideo.findUnique({ where: { id: f.source.id } })).toMatchObject({ width: 96, height: 64 });
  }, 30000);

  it.each(["none", "before-render", "during-render", "before-completion", "changed-boundaries", "missing-evidence"] as const)(
    "checks original exports against retained regions (%s)", async scenario => {
      const f = await fixture();
      await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { width: 96, height: 64, durationS: 2 } });
      await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
        "testsrc2=s=96x64:d=2:r=25", "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=2",
        "-c:v", "libx264", "-threads", "1", "-c:a", "aac", "-f", "mp4", provider.absolutePath(f.source.storageKey!)], { timeout: 30000 });
      const clip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
        rank: 1, startMs: 400, endMs: 1200, title: "Original fixture", summary: "Generated media" } });
      const job = await prisma.exportJob.create({ data: { workspaceId: f.workspace.id, clipId: clip.id,
        editVersion: 0, filename: "original.mp4", idempotencyKey: randomUUID(), state: "RUNNING", attempt: 1 } });
      const registerForbidden = () => recordMediaRegion(prisma, f.workspace.id, { sourceVideoId: f.source.id,
        sourceSha256: "d".repeat(64), sourceInterval: { startMs: 600, endMs: 800 }, kind: "PRAYER",
        detectorVersion: "fixture-only", configurationSha256: "a".repeat(64), inputSha256: "b".repeat(64),
        evidenceSha256: "c".repeat(64), confidence: 0.2, slideSubtype: null, ocrEvidence: null });
      if (scenario === "before-render" || scenario === "during-render") {
        if (scenario === "before-render") await registerForbidden();
        const storage = getStorageProvider();
        const download = storage.downloadToFile.bind(storage);
        const spy = vi.spyOn(storage, "downloadToFile").mockImplementationOnce(async (...args) => {
          const result = await download(...args);
          if (scenario === "during-render") await registerForbidden();
          return result;
        });
        try {
          await expect(runExportJob(prisma, job)).rejects.toMatchObject({ code: "EXPORT_FORBIDDEN_REGION", terminal: true });
          expect(spy).toHaveBeenCalledTimes(scenario === "during-render" ? 1 : 0);
          expect(await prisma.exportedFile.count({ where: { storageKey: `exports/${f.workspace.id}/${job.id}.mp4` } })).toBe(0);
        } finally { spy?.mockRestore(); }
        return;
      }
      const outputId = await runExportJob(prisma, job);
      if (scenario === "before-completion") await registerForbidden();
      if (scenario === "changed-boundaries") await prisma.generatedClip.update({ where: { id: clip.id }, data: { startMs: 500 } });
      if (scenario === "missing-evidence") await prisma.exportJob.update({ where: { id: job.id }, data: { qcDetails: {} } });
      if (scenario !== "none") {
        const code = scenario === "before-completion" ? "EXPORT_FORBIDDEN_REGION"
          : scenario === "changed-boundaries" ? "EXPORT_REGION_SOURCE_MISMATCH" : "EXPORT_REGION_EVIDENCE_MISSING";
        await expect(markExportJobSucceeded(prisma, job.id, outputId)).rejects.toMatchObject({ code, terminal: true });
        expect(await prisma.exportJob.findUnique({ where: { id: job.id } })).toMatchObject({ state: "RUNNING", outputFileId: null });
        return;
      }
      expect(await markExportJobSucceeded(prisma, job.id, outputId)).toBe(true);
      expect(await prisma.exportJob.findUnique({ where: { id: job.id } })).toMatchObject({ state: "SUCCEEDED",
        qcDetails: { regionCheck: { identityScope: "all_retained_source_identities", coverage: "not_proven" },
          mediaInput: { kind: "ORIGINAL", sourceVideoId: f.source.id, sourceInterval: { startMs: 400, endMs: 1200 } } } });
    }, 60000);

  it.each(["none", "before-render", "before-completion"] as const)("runs a persisted range export with region checks (%s)", async blockedAt => {
    const f = await fixture();
    await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { width: 96, height: 64, durationS: 2 } });
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
      "testsrc2=s=96x64:d=2:r=25", "-f", "lavfi", "-i", "sine=sample_rate=48000:duration=2",
      "-c:v", "libx264", "-threads", "1", "-g", "10", "-bf", "0", "-sc_threshold", "0", "-c:a", "pcm_s16le",
      "-f", "mov", provider.absolutePath(f.source.storageKey!)], { timeout: 30000 });
    const batch = await runCandidateRangeBatch(prisma, provider, f.request, {
      sourceDurationMs: 2000, sourceOriginMs: 0,
      candidates: [{ candidateId: "worker", sourceInterval: { startMs: 400, endMs: 1200 } }],
      handles: { beforeMs: 0, afterMs: 0 }, expiresAt: null,
      keyframes: { timeoutMs: 30000, maxOutputBytes: 1024 * 1024, maxPackets: 1000 },
      extraction: { mode: "prefer-stream-copy", threads: 1, timeoutMs: 30000,
        maxOutputBytes: 1024 * 1024, maxFileBytes: 10 * 1024 * 1024, maxProofFrames: 1000 },
    });
    const artifact = batch.ranges[0].artifact;
    await recordArtifactReview(prisma, { workspaceId: f.workspace.id, sourceVideoId: f.source.id,
      artifactId: artifact.id, reviewerId: f.workspace.ownerId, expectedRevision: 0, decision: "ACCEPTED",
      sourceSha256: artifact.sourceSha256, artifactSha256: artifact.sha256,
      mappingEvidenceSha256: artifact.mappingEvidenceSha256!, evidence: {
        comparisonReference: "generated-worker-fixture", notes: "Simulated review for integration testing only.",
        fullRangeCompared: true, dimensionsChecked: true, timingChecked: true, visualQualityAcceptable: true } });
    const clip = await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 400, endMs: 1200, title: "Worker fixture", summary: "Generated media" } });
    const queued = await enqueueRangeExportJob(prisma, { workspaceId: f.workspace.id, clipId: clip.id,
      artifactId: artifact.id, editVersion: 0, filename: "range-worker.mp4", priority: 2147483647 });
    // Delete only this generated fixture original. Production deletion needs separate acceptance evidence.
    await rm(provider.absolutePath(f.source.storageKey!));
    await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { storageKey: null } });
    const previous = process.env.P4_RANGE_EXPORTS_ENABLED;
    process.env.P4_RANGE_EXPORTS_ENABLED = "true";
    try {
      const claimed = await claimNextExportJob(prisma);
      expect(claimed?.id).toBe(queued.job.id);
      const registerForbidden = () => recordMediaRegion(prisma, f.workspace.id, { sourceVideoId: f.source.id,
        sourceSha256: artifact.sourceSha256, sourceInterval: { startMs: 600, endMs: 800 }, kind: "FULLSCREEN_SLIDE",
        detectorVersion: "fixture-only", configurationSha256: "a".repeat(64), inputSha256: "b".repeat(64),
        evidenceSha256: "c".repeat(64), confidence: 0.2, slideSubtype: "SCRIPTURE", ocrEvidence: "Fixture" });
      if (blockedAt === "before-render") {
        await registerForbidden();
        const downloads = provider.downloadKeys.length;
        await expect(runExportJob(prisma, claimed!)).rejects.toMatchObject({ code: "EXPORT_FORBIDDEN_REGION", terminal: true });
        expect(provider.downloadKeys).toHaveLength(downloads);
        expect(await prisma.exportedFile.count({ where: { storageKey: `exports/${f.workspace.id}/${claimed!.id}.mp4` } })).toBe(0);
        return;
      }
      const outputId = await runExportJob(prisma, claimed!);
      if (blockedAt === "before-completion") {
        await registerForbidden();
        await expect(markExportJobSucceeded(prisma, claimed!.id, outputId)).rejects.toMatchObject({ code: "EXPORT_FORBIDDEN_REGION", terminal: true });
        expect(await prisma.exportJob.findUnique({ where: { id: claimed!.id } })).toMatchObject({ state: "RUNNING", outputFileId: null });
        return;
      }
      expect(await markExportJobSucceeded(prisma, claimed!.id, outputId)).toBe(true);
      const slot = await prisma.scheduledPost.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
        clipId: clip.id, exportJobId: claimed!.id, scheduledDate: new Date("2026-10-16") } });
      const beforeRegion = await loadDeliveryFacts(prisma, { scheduledPostId: slot.id });
      expect(beforeRegion?.exportJob).toMatchObject({ usesRangeInput: true, sourceRegionStatus: "clear" });
      await registerForbidden();
      const afterRegion = await loadDeliveryFacts(prisma, { scheduledPostId: slot.id });
      expect(afterRegion?.exportJob).toMatchObject({ usesRangeInput: true, sourceRegionStatus: "blocked" });
      // Simulate only publishing configuration in memory. No external provider call occurs.
      expect(assessDeliveryEligibility({ ...afterRegion!, globalPublishingEnabled: true, programState: null,
        settings: { customerApprovalRequired: false, pilotHold: false },
        connection: { pageId: "fixture", autoPostEnabled: true } })).toEqual({ eligible: false, reason: "source_region_forbidden" });
      const output = await prisma.exportedFile.findUniqueOrThrow({ where: { id: outputId } });
      expect(await fileIdentity(provider.absolutePath(output.storageKey))).toEqual({
        sha256: output.checksum, byteCount: Number(output.bytes) });
      const probe = await probeVideoFile(provider.absolutePath(output.storageKey));
      expect(probe).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
      expect(Math.abs(probe.durationS - 0.8)).toBeLessThan(0.1);
      const finished = await prisma.exportJob.findUniqueOrThrow({ where: { id: queued.job.id } });
      expect(finished).toMatchObject({ state: "SUCCEEDED", qcStatus: "PASSED", qcChecksum: output.checksum,
        qcDetails: { mediaInput: { kind: "CANDIDATE_RANGE", artifactId: artifact.id, reviewId: queued.pin.reviewId } } });
      const events = await prisma.operationalEvent.findMany({ where: { exportJobId: queued.job.id, eventType: "processing_cost_fact" } });
      const facts = events.map(event => event.metadata as Prisma.JsonObject);
      expect(facts).toHaveLength(3);
      expect(facts.every(fact => fact.outcome === "succeeded")).toBe(true);
      expect(facts.map(fact => fact.stage).sort()).toEqual(["download", "render", "upload"]);
      expect(facts.find(fact => fact.stage === "download")).toMatchObject({ bytes: Number(artifact.byteCount), attempt: 1 });
      expect(facts.find(fact => fact.stage === "upload")).toMatchObject({ bytes: Number(output.bytes), attempt: 1 });
      expect(facts.find(fact => fact.stage === "render")).toMatchObject({ quantity: 0.8, unit: "second" });
      expect(await prisma.sourceMediaSession.findMany({ where: { sourceId: f.source.id, purpose: "P4_RANGE_RENDER" } }))
        .toEqual([expect.objectContaining({ state: "COMPLETE" })]);
    } finally {
      if (previous === undefined) delete process.env.P4_RANGE_EXPORTS_ENABLED; else process.env.P4_RANGE_EXPORTS_ENABLED = previous;
    }
  }, 60000);

  it.each([false, true])("stops controlled PROBE before acquisition for missing settings or SRT (srt=%s)", async srt => {
    const f = await fixture();
    if (srt) await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { srtOverrideKey: "fixture.srt" } });
    const previous = process.env.P4_SERMON_PREPARATION_ENABLED;
    try {
      process.env.P4_SERMON_PREPARATION_ENABLED = "true";
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(runProbeJob({ prisma, job: { ...f.job, type: "PROBE" } }))
          .rejects.toMatchObject({ code: "SERMON_PREPARATION_REQUIRED", retryable: false });
      }
      expect(await prisma.editorialException.count({ where: { projectId: f.project.id,
        exceptionType: "SERMON_PREPARATION_REQUIRED", state: "OPEN" } })).toBe(1);
      expect(await prisma.sourceMediaSession.count({ where: { sourceId: f.source.id } })).toBe(0);
      expect(await prisma.processingJob.count({ where: { projectId: f.project.id, type: "TRANSCRIBE" } })).toBe(0);
      expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.P4_SERMON_PREPARATION_ENABLED;
      else process.env.P4_SERMON_PREPARATION_ENABLED = previous;
    }
  });

  it.each(["present", "missing"] as const)("prepares derivatives for an uploaded SRT without speech recognition (srt=%s)", async srtState => {
    const f = await fixture();
    await writeMedia(f.source.storageKey!);
    const srtKey = `srt/${randomUUID()}.srt`;
    await mkdir(path.dirname(provider.absolutePath(srtKey)), { recursive: true });
    if (srtState === "present") await writeFile(provider.absolutePath(srtKey), "1\n00:00:00,100 --> 00:00:00,800\nHello church.\n");
    await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { srtOverrideKey: srtKey, language: "en" } });
    await prisma.project.update({ where: { id: f.project.id }, data: { processingConfig: {
      sermonPreparation: JSON.parse(JSON.stringify({ version: "sermon-preparation-v1", derivatives: batchSettings,
        localEvidence: evidenceSettings, retention: batchRetention,
        sermon: { corridor: { sourceInterval: { startMs: 100, endMs: 900 }, detectorVersion: "fixture-only-v1",
          evidenceSha256: "b".repeat(64), confidence: 0.9 }, settings: { threads: 1, flacCompressionLevel: 5,
          timeoutMs: 30000, maxMetadataBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 } },
        structureAudio: { silenceNoiseDb: -45, silenceMinimumMs: 100, waveformWindowSamples: 1600, threads: 1,
          timeoutMs: 30000, maxMetadataBytes: 1024 * 1024 },
        structureBoundaries: { paragraphSilenceMinimumMs: 200, splitOnSpeakerChange: true, nonTerminalTokens: [] } })),
    } } });
    const previous = process.env.P4_SERMON_PREPARATION_ENABLED;
    const storageSpy = vi.spyOn(storageModule, "getStorageProvider").mockReturnValue(provider);
    // Any speech-provider resolution is a failure: an uploaded SRT must never become paid ASR.
    const providerSpy = vi.spyOn(transcriptionModule, "resolveTranscriptionProviders").mockImplementation(() => {
      throw new Error("SPEECH_PROVIDER_MUST_NOT_RUN");
    });
    try {
      process.env.P4_SERMON_PREPARATION_ENABLED = "true";
      const probeJob = await prisma.processingJob.update({ where: { id: f.job.id }, data: { type: "PROBE" } });
      if (srtState === "missing") {
        await expect(runProbeJob({ prisma, job: probeJob })).rejects.toMatchObject({ code: "SERMON_PREPARATION_REQUIRED", retryable: false });
        expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(0);
        expect(await prisma.sourceMediaSession.count({ where: { sourceId: f.source.id } })).toBe(0);
        expect(await prisma.processingJob.count({ where: { projectId: f.project.id, type: "TRANSCRIBE" } })).toBe(0);
        return;
      }
      const prepared = await runProbeJob({ prisma, job: probeJob });
      expect(prepared?.metadata).toMatchObject({ transcriptSource: "srt_override" });
      expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(1);
      const kinds = (await prisma.derivedMediaArtifact.findMany({ where: { sourceVideoId: f.source.id, publicationState: "READY" } }))
        .map(artifact => artifact.kind);
      expect(kinds).toEqual(expect.arrayContaining(["ANALYSIS_AUDIO", "SOURCE_PROXY", "LOCAL_EVIDENCE"]));
      expect(kinds).not.toContain("SERMON_AUDIO");
      expect(await prisma.sermonTranscriptionSubmission.count({ where: { sourceVideoId: f.source.id } })).toBe(0);
      expect(await prisma.sourceMediaSession.findMany({ where: { sourceId: f.source.id } }))
        .toEqual([expect.objectContaining({ state: "COMPLETE" })]);
      expect(await readdir(f.request.temporaryRoot).catch(() => [])).toEqual([]);
      const transcribe = await prisma.processingJob.findUniqueOrThrow({ where: { idempotencyKey: `transcribe:${f.project.id}` } });
      expect(transcribe).toMatchObject({ type: "TRANSCRIBE", state: "QUEUED" });
      // The existing TRANSCRIBE job parses the uploaded file. It needs no audio key and no provider.
      await runTranscribeJob({ prisma, job: transcribe });
      const transcript = await prisma.transcript.findUniqueOrThrow({ where: { sourceVideoId: f.source.id }, include: { segments: true } });
      expect(transcript.provider).toBe("srt_upload");
      expect(transcript.provenance).toMatchObject({ kind: "USER_SUPPLIED_SRT", sourceVideoId: f.source.id,
        textAndCueTiming: { status: "user-supplied", inputSha256: (await fileIdentity(provider.absolutePath(srtKey))).sha256 } });
      expect(transcript.capabilities).toMatchObject({ wordTimestamps: { status: "derived" },
        wordConfidence: { status: "unavailable" }, speakerLabels: { status: "unavailable" } });
      expect(transcript.segments.flatMap(segment => (segment.words as Array<{ word: string }>).map(word => word.word)).join(" "))
        .toContain("church");
      expect(await prisma.sourceVideo.findUniqueOrThrow({ where: { id: f.source.id } })).toMatchObject({
        width: 1920, height: 1080, audioKey: null, srtOverrideKey: srtKey });
    } finally {
      storageSpy.mockRestore(); providerSpy.mockRestore();
      if (previous === undefined) delete process.env.P4_SERMON_PREPARATION_ENABLED; else process.env.P4_SERMON_PREPARATION_ENABLED = previous;
    }
  }, 60000);

  it("keeps source regions through transcript replacement, clip rebuilds, and deletion of a sharing project", async () => {
    const f = await fixture();
    const sibling = await prisma.project.create({ data: { workspaceId: f.workspace.id, sourceVideoId: f.source.id,
      name: "Sibling service", status: "READY" } });
    const fact = { sourceVideoId: f.source.id, sourceSha256: "d".repeat(64), detectorVersion: "fixture-only",
      configurationSha256: "a".repeat(64), inputSha256: "b".repeat(64), evidenceSha256: "c".repeat(64),
      confidence: 0.5, slideSubtype: null, ocrEvidence: null };
    const prayer = await recordMediaRegion(prisma, f.workspace.id, { ...fact, kind: "PRAYER", sourceInterval: { startMs: 2000, endMs: 3000 } });
    const sermon = await recordMediaRegion(prisma, f.workspace.id, { ...fact, kind: "SERMON", sourceInterval: { startMs: 3000, endMs: 50000 } });
    const snapshot = async () => (await prisma.mediaRegion.findMany({ where: { sourceVideoId: f.source.id }, orderBy: { id: "asc" } }));
    const before = await snapshot();
    expect(before.map(region => region.id).sort()).toEqual([prayer.id, sermon.id].sort());

    // Reanalysis replaces the source transcript. Use the real TRANSCRIBE path twice through an uploaded SRT.
    const srtKey = `srt/${randomUUID()}.srt`;
    await mkdir(path.dirname(provider.absolutePath(srtKey)), { recursive: true });
    await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { srtOverrideKey: srtKey, language: "en" } });
    const storageSpy = vi.spyOn(storageModule, "getStorageProvider").mockReturnValue(provider);
    try {
      for (const [revision, text] of [[1, "First words."], [2, "Second words."]] as const) {
        await writeFile(provider.absolutePath(srtKey), `1\n00:00:01,000 --> 00:00:02,000\n${text}\n`);
        const job = await prisma.processingJob.create({ data: { projectId: f.project.id, type: "TRANSCRIBE", idempotencyKey: randomUUID() } });
        await runTranscribeJob({ prisma, job });
        expect(await prisma.sourceVideo.findUniqueOrThrow({ where: { id: f.source.id } })).toMatchObject({ transcriptRevision: revision });
        expect(await snapshot()).toEqual(before);
      }
    } finally { storageSpy.mockRestore(); }

    // A clip rebuild deletes the project's clips; the source regions do not depend on them.
    await prisma.generatedClip.create({ data: { workspaceId: f.workspace.id, projectId: f.project.id,
      rank: 1, startMs: 2100, endMs: 2900, title: "Rebuilt away", summary: "Local fixture", transcriptRevision: 2 } });
    await prisma.generatedClip.deleteMany({ where: { projectId: f.project.id } });
    expect(await snapshot()).toEqual(before);

    // Deleting one project leaves the facts for every other project that shares the source.
    await prisma.project.delete({ where: { id: f.project.id } });
    expect(await snapshot()).toEqual(before);
    await expect(assertOriginalRegionExportAllowed(prisma, { workspaceId: f.workspace.id, sourceVideoId: f.source.id,
      sourceInterval: { startMs: 2500, endMs: 3500 } })).rejects.toMatchObject({ code: "EXPORT_FORBIDDEN_REGION" });
    expect(await prisma.project.findUniqueOrThrow({ where: { id: sibling.id } })).toMatchObject({ sourceVideoId: f.source.id });
  });

  it("publishes timeline and boundary views from the shared proxy under one source acquisition", async () => {
    const f = await fixture();
    await writeMedia(f.source.storageKey!);
    const views = (["TIMELINE_VIEW", "BOUNDARY_STRIP"] as const).map(kind => ({ kind,
      sampling: { sourceInterval: { startMs: 0, endMs: 1000 }, count: 2, maxDistanceMs: 500 }, columns: 2, tileHeight: 120, maxPixels: 1000000, maxFileBytes: 1048576,
      frames: evidenceSettings.representatives }));
    const batch = await runAnalysisDerivativeBatch(prisma, provider, f.request, batchSettings, batchRetention,
      evidenceSettings, undefined, undefined, undefined, views);
    expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(1);
    expect(batch.views).toHaveLength(2);
    for (const [index, published] of batch.views.entries()) {
      expect(published.artifact).toMatchObject({ kind: views[index].kind, publicationState: "READY", retentionClass: "PREVIEW",
        expiresAt: batchRetention.previewExpiresAt, startMs: BigInt(0), endMs: BigInt(521), mappingStatus: "DECLARED",
        publicationEvidence: { derivation: { proxyArtifactId: batch.proxy.artifact.id, coverage: "sampled-instants-only",
          samplingEvidence: { localEvidenceArtifactId: batch.localEvidence!.artifact.id,
            localEvidenceSha256: batch.localEvidence!.artifact.sha256, sourceTimesMs: [0, 520] },
          cells: [expect.objectContaining({ sourceTimeMs: 0 }), expect.objectContaining({ sourceTimeMs: 520 })] } } });
      expect(await fileIdentity(provider.absolutePath(published.artifact.storageKey))).toEqual({
        sha256: published.artifact.sha256, byteCount: Number(published.artifact.byteCount) });
    }
    expect(await readdir(f.request.temporaryRoot)).toEqual([]);
    expect(await prisma.sourceMediaSession.findUnique({ where: { id: batch.sessionId } })).toMatchObject({ state: "COMPLETE" });
  }, 30000);

  it.each(["success", "concurrent", "uncertain", "budget", "image-limit", "clear", "owner", "overrun", "response-limit"] as const)(
    "reserves one visual escalation per source (%s)", async mode => {
      const f = await fixture();
      let calls = 0;
      const evidenceArtifacts: Array<{ id: string; storageKey: string }> = [];
      await withMaterializedSource(prisma, provider, f.request, async source => {
        const owner = { workspaceId: f.workspace.id, ownerId: f.request.ownerId, sessionId: source.sessionId };
        // Dummy artifact bytes test durable admission. No vision model or image decoder runs here.
        const publish = async (kind: "LOCAL_EVIDENCE" | "SPARSE_FRAME", version: string, contents: string, derivation: Prisma.InputJsonObject) => {
          const file = path.join(source.directory, version);
          await writeFile(file, contents);
          const local = await fileIdentity(file);
          return publishMediaArtifact(prisma, provider, owner, { sourceVideoId: f.source.id, sourceSha256: source.sha256,
            kind, sourceInterval: { startMs: 0, endMs: 1000 }, derivationVersion: version,
            configurationSha256: rangeEvidenceSha256(contents), storageKey: `sources/${f.source.id}/${version}.fixture`,
            sha256: local.sha256, byteCount: BigInt(local.byteCount), retentionClass: "ANALYSIS", expiresAt: null,
            mappingStatus: "DECLARED", mappingEvidenceSha256: null, visualQuality: "NOT_APPLICABLE" }, file,
          "application/octet-stream", derivation);
        };
        const decision = await publish("LOCAL_EVIDENCE", "registered-boundary-resolution-v1", '{"fixtureOnly":true}',
          { boundaryStatus: mode === "clear" ? "RESOLVED" : "AMBIGUOUS" });
        const image = await publish("SPARSE_FRAME", "visual-image-fixture", "dummy image bytes", {});
        evidenceArtifacts.push(decision.artifact, image.artifact);
        const request: VisualEscalationRequest = { ...owner, sourceVideoId: f.source.id,
          boundaryDecisionArtifactId: decision.artifact.id, imageArtifactIds: [image.artifact.id], maxImageBytes: mode === "image-limit" ? 1 : 1000,
          preparedRequestSha256: "a".repeat(64), provider: "fixture", model: "fixture-vision", policyVersion: "fixture-v1",
          maxResponseBytes: mode === "response-limit" ? 1 : 10000,
          budget: { maxInputTokens: 100, maxOutputTokens: 20, inputMicroUsdPerMillionTokens: 1000000,
            outputMicroUsdPerMillionTokens: 2000000, budgetMicroUsd: mode === "budget" ? 139 : 140,
            priceEvidenceReference: "fixture-only-not-real-prices" } };
        if (mode === "owner") request.ownerId = randomUUID();
        let release: () => void = () => {}, entered: () => void = () => {};
        const pending = new Promise<void>(resolve => { release = resolve; });
        const dispatched = new Promise<void>(resolve => { entered = resolve; });
        const submit = async (admission: { escalationId: string }) => {
          calls++;
          expect(await prisma.visualBoundaryEscalation.findUnique({ where: { id: admission.escalationId } }))
            .toMatchObject({ state: "STARTED", reservedCostMicroUsd: BigInt(140), budgetMicroUsd: BigInt(140) });
          entered();
          if (mode === "concurrent") await pending;
          if (mode === "uncertain") throw new Error("simulated lost provider response");
          return { providerRequestId: "fixture-response", usage: { inputTokens: 10, outputTokens: mode === "overrun" ? 30 : 5 },
            response: { status: "AMBIGUOUS", reason: "Fixture only." } };
        };
        if (["budget", "image-limit", "clear", "owner"].includes(mode)) {
          await expect(runVisualBoundaryEscalationOnce(prisma, request, submit)).rejects.toThrow();
          expect(calls).toBe(0);
          expect(await prisma.visualBoundaryEscalation.count({ where: { sourceVideoId: f.source.id } })).toBe(0);
          return;
        }
        if (mode === "uncertain" || mode === "response-limit") {
          await expect(runVisualBoundaryEscalationOnce(prisma, request, submit)).rejects.toThrow();
          await expect(runVisualBoundaryEscalationOnce(prisma, request, submit)).rejects.toThrow("VISUAL_ESCALATION_UNCERTAIN");
          expect(calls).toBe(1);
          expect(await prisma.visualBoundaryEscalation.findUnique({ where: { sourceVideoId: f.source.id } })).toMatchObject({ state: "UNCERTAIN" });
          return;
        }
        if (mode === "overrun") {
          await expect(runVisualBoundaryEscalationOnce(prisma, request, submit)).rejects.toThrow("RESPONSE_EXCEEDED_LIMITS");
          await expect(runVisualBoundaryEscalationOnce(prisma, request, submit)).rejects.toThrow("RESPONSE_EXCEEDED_LIMITS");
          expect(calls).toBe(1);
          expect(await prisma.visualBoundaryEscalation.findUnique({ where: { sourceVideoId: f.source.id } }))
            .toMatchObject({ state: "COMPLETED", result: { limitsExceeded: true, usage: { outputTokens: 30 } } });
          return;
        }
        const firstRequest = runVisualBoundaryEscalationOnce(prisma, request, submit);
        if (mode === "concurrent") {
          await dispatched;
          try {
            await expect(runVisualBoundaryEscalationOnce(secondClient, request, submit)).rejects.toThrow("VISUAL_ESCALATION_UNCERTAIN");
          } finally { release(); }
        }
        const first = await firstRequest;
        expect(first).toMatchObject({ reused: false, result: { reportedCostMicroUsd: "20", limitsExceeded: false, providerBillingVerified: false } });
        expect(await runVisualBoundaryEscalationOnce(prisma, request, submit)).toMatchObject({ reused: true, escalationId: first.escalationId });
        await expect(runVisualBoundaryEscalationOnce(prisma, { ...request, preparedRequestSha256: "b".repeat(64) }, submit))
          .rejects.toThrow("VISUAL_ESCALATION_ALREADY_USED");
        expect(calls).toBe(1);
        await expect(prisma.visualBoundaryEscalation.update({ where: { id: first.escalationId }, data: { state: "STARTED" } })).rejects.toThrow();
        await expect(prisma.visualBoundaryEscalation.update({ where: { id: first.escalationId }, data: { budgetMicroUsd: BigInt(999) } })).rejects.toThrow();
        await expect(prisma.visualBoundaryEscalation.delete({ where: { id: first.escalationId } })).rejects.toThrow();
        const facts = (await prisma.operationalEvent.findMany({ where: { workspaceId: f.workspace.id, eventType: "processing_cost_fact" } }))
          .map(event => event.metadata as Prisma.JsonObject);
        expect(facts).toHaveLength(1);
        expect(facts[0]).toMatchObject({ stage: "analysis_classification", provider: "fixture", totalCostUsd: 0.00002,
          details: { providerBillingVerified: false } });
      });
      if (mode === "uncertain" || mode === "response-limit") {
        await prisma.project.update({ where: { id: f.project.id }, data: { expiresAt: new Date("2020-01-01") } });
        await prisma.derivedMediaArtifact.updateMany({ where: { sourceVideoId: f.source.id }, data: { expiresAt: new Date("2020-01-01") } });
        expect(await cleanupExpiredMediaArtifacts(prisma, provider, { workspaceId: f.workspace.id, sourceVideoId: f.source.id,
          ownerId: randomUUID(), maxArtifacts: 10 })).toMatchObject({ sessionId: null, deletedArtifactIds: [] });
        for (const artifact of evidenceArtifacts) expect(await provider.exists(artifact.storageKey)).toBe(true);
      }
    }, 30000);

  it.each(["resolved", "ambiguous", "outside-evidence", "document-limit", "unsampled-edge",
    "visual-resolved", "visual-ambiguous", "visual-failed", "visual-budget", "visual-invalid", "visual-image-invalid", "visual-http"] as const)(
    "registers boundary samples and decisions before Scribe (%s)", async mode => {
      const visualMode = mode.startsWith("visual-");
      const f = await fixture();
      await writeMedia(f.source.storageKey!);
      const fixtureOcr = await makeOcrRequest(f.source.id, "success");
      const output = { result: { language: "en" }, transcription: [{ text: " Hello", offsets: { from: 0, to: 100 },
        tokens: [{ text: " Hello", offsets: { from: 0, to: 100 }, p: 0.9 }] }] };
      await writeFile(fixtureOcr.settings.binaryPath, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "-of" ]; then shift; target="$1.json"; fi\n shift\ndone\nprintf '%s' '${JSON.stringify(output)}' > "$target"\n`, { mode: 0o700 });
      let resolverCalls = 0, scribeCalls = 0, visualCalls = 0, visualPreparations = 0;
      const boundaryAsr: BoundaryAsrBatchRequest = {
        settings: { binaryPath: fixtureOcr.settings.binaryPath, modelRoot: fixtureOcr.settings.modelRoot, usage: "evaluation",
          model: { ...fixtureOcr.settings.model, roles: ["BOUNDARY_ASR"] }, language: "en", threads: 1,
          timeoutMs: 30000, maxOutputBytes: 1048576,
          extraction: { threads: 1, flacCompressionLevel: 5, timeoutMs: 30000, maxMetadataBytes: 1048576, maxFileBytes: 1048576 } },
        maxDocumentBytes: mode === "document-limit" ? 1 : 1048576,
        plan: { maxWindowMs: 200, maxTotalMs: 400, windows: [
          { edge: "START", state: "AMBIGUOUS", sourceInterval: { startMs: 0, endMs: 200 }, evidenceSha256: "b".repeat(64) },
          ...(mode === "unsampled-edge" ? [] : [{ edge: "END" as const, state: "AMBIGUOUS" as const,
            sourceInterval: { startMs: 800, endMs: 1000 }, evidenceSha256: "c".repeat(64) }]),
        ] },
        resolve: async context => {
          resolverCalls++;
          expect(await prisma.derivedMediaArtifact.findUnique({ where: { id: context.artifactId } }))
            .toMatchObject({ publicationState: "READY", sha256: context.artifactSha256 });
          expect(context.evidence.boundaryStatus).toBe("unresolved");
          if (mode === "ambiguous" || visualMode) return { status: "AMBIGUOUS", reason: "Fixture requires human review." };
          return { status: "RESOLVED", reason: "Simulated resolver for integration tests only.",
            corridor: { ...context.initialCorridor, sourceInterval: { startMs: mode === "outside-evidence" ? 250 : 120, endMs: 880 },
              detectorVersion: "fixture-resolver-v1", evidenceSha256: "d".repeat(64), confidence: 0.8 } };
        },
      };
      if (visualMode || mode === "resolved") boundaryAsr.prepareVisualEscalation = async context => {
        visualPreparations++;
        expect(context.availableImages).toHaveLength(mode === "visual-http" ? 3 : 1);
        const decision = await prisma.derivedMediaArtifact.findUniqueOrThrow({ where: { id: context.localDecisionArtifactId } });
        expect(decision.publicationEvidence).toMatchObject({ derivation: { boundaryStatus: "AMBIGUOUS" } });
        if (mode === "visual-http") {
          const images = await Promise.all(context.availableImages.map(async image => {
            const artifact = await prisma.derivedMediaArtifact.findUniqueOrThrow({ where: { id: image.id } });
            const common = { artifactId: image.id, sha256: image.sha256, byteCount: Number(image.byteCount),
              bytes: await provider.readAsBuffer(artifact.storageKey) };
            if (image.kind === "SPARSE_FRAME") return { ...common, kind: "SPARSE_FRAME" as const, sourceTimeMs: Number(image.startMs) };
            if (image.kind !== "TIMELINE_VIEW" && image.kind !== "BOUNDARY_STRIP") throw new Error("Unexpected fixture image.");
            const viewEvidence = proxyViewEvidenceSchema.parse(z.object({ derivation: z.unknown() }).parse(image.publicationEvidence).derivation);
            expect(viewEvidence.sourceInterval).toEqual({ startMs: Number(image.startMs), endMs: Number(image.endMs) });
            expect(viewEvidence.kind).toBe(image.kind);
            return { ...common, kind: viewEvidence.kind, viewEvidence };
          }));
          return prepareAnthropicVisualBoundaryRequest({ images, evidence: { initialCorridor: context.initialCorridor,
            samplingEvidence: context.samplingEvidence }, settings: { model: "fixture-vision", policyVersion: "fixture-v1",
            contextCeiling: { model: "fixture-vision", maxInputTokens: 100, evidenceReference: "fixture-context-only" },
            maxRequestBytes: 1048576, maxResponseBytes: 1048576, maxImageBytes: 1048576, timeoutMs: 30000,
            budget: { maxInputTokens: 100, maxOutputTokens: 20, inputMicroUsdPerMillionTokens: 1000000,
              outputMicroUsdPerMillionTokens: 2000000, budgetMicroUsd: 140, priceEvidenceReference: "fixture-only-prices" } } },
          { apiKey: "fixture-only", fetchImpl: async (url, options) => {
            visualCalls++;
            expect(url).toBe("https://api.anthropic.com/v1/messages");
            const body = JSON.parse(String(options?.body));
            expect(body.messages[0].content[1].source.media_type).toBe("image/webp");
            expect(body.messages[0].content[2].text).toContain("TIMELINE_VIEW");
            expect(body.messages[0].content[4].text).toContain("BOUNDARY_STRIP");
            expect(body.messages[0].content[2].text).toContain('"sourceTimeMs":0');
            expect(body.messages[0].content[4].text).toContain('"sourceTimeMs":480');
            expect(await prisma.visualBoundaryEscalation.findUnique({ where: { sourceVideoId: f.source.id } }))
              .toMatchObject({ state: "STARTED", requestEvidence: { inputTokenBoundEvidence: { method: "model_context_ceiling" } } });
            return Response.json({ id: "fixture-http-id", model: "fixture-vision", stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "text", text: JSON.stringify({ status: "RESOLVED",
                reason: "Simulated HTTP response.", corridor: { confidence: 0.8, sourceInterval: { startMs: 120, endMs: 880 } } }) }] });
          } });
        }
        return { request: { imageArtifactIds: mode === "visual-image-invalid" ? [randomUUID()] : context.availableImages.map(image => image.id),
          maxImageBytes: 1048576, preparedRequestSha256: rangeEvidenceSha256({ decision: context.localDecisionArtifactSha256,
            images: context.availableImages.map(image => image.sha256) }), provider: "fixture", model: "fixture-vision", policyVersion: "fixture-v1",
          maxResponseBytes: 1048576, budget: { maxInputTokens: 100, maxOutputTokens: 20, inputMicroUsdPerMillionTokens: 1000000,
            outputMicroUsdPerMillionTokens: 2000000, budgetMicroUsd: mode === "visual-budget" ? 139 : 140,
            priceEvidenceReference: "fixture-only-not-real-prices" } }, submit: async () => {
          visualCalls++;
          if (mode === "visual-failed") throw new Error("Simulated lost vision response.");
          return { providerRequestId: "fixture-vision-id", usage: { inputTokens: 10, outputTokens: 5 },
            response: mode === "visual-ambiguous" ? { status: "AMBIGUOUS", reason: "Simulated unresolved visual decision." }
              : { status: "RESOLVED", reason: "Simulated visual resolution.", corridor: { ...context.initialCorridor,
                detectorVersion: "fixture-visual-v1", evidenceSha256: "e".repeat(64), confidence: 0.8,
                sourceInterval: { startMs: mode === "visual-invalid" ? 250 : 120, endMs: 880 } } } };
        } };
      };
      const scribe = new ScribeTranscriptionProvider({ apiKey: "fixture-only", request: async () => {
        scribeCalls++;
        const ready = await prisma.derivedMediaArtifact.findMany({ where: { sourceVideoId: f.source.id, publicationState: "READY" } });
        expect(ready.map(artifact => artifact.derivationVersion)).toEqual(expect.arrayContaining([
          "registered-boundary-asr-v1", "registered-boundary-resolution-v1",
        ]));
        if (visualMode) {
          expect(ready.some(artifact => artifact.derivationVersion === "registered-visual-boundary-resolution-v1")).toBe(true);
          expect(await prisma.visualBoundaryEscalation.findUnique({ where: { sourceVideoId: f.source.id } })).toMatchObject({ state: "COMPLETED" });
        }
        expect(ready.find(artifact => artifact.kind === "SERMON_AUDIO")).toMatchObject({ startMs: BigInt(120), endMs: BigInt(880) });
        return { language_code: "en", text: "Hello.", words: [{ type: "word", text: "Hello.", start: 0.1, end: 0.5, logprob: -0.1 }] };
      } });
      const input = { request: f.request, projectId: f.project.id, derivatives: batchSettings, retention: batchRetention,
        localEvidence: evidenceSettings, provider: scribe, boundaryAsr,
        views: mode === "visual-http" ? (["TIMELINE_VIEW", "BOUNDARY_STRIP"] as const).map(kind => ({
          kind, sourceTimesMs: [0, 480], columns: 2, tileHeight: 32, maxPixels: 100000,
          maxFileBytes: 1048576, frames: evidenceSettings.representatives!,
        })) : [],
        storageAccounting: { provider: "local" as const, downloadPricePerGbUsd: null, uploadPricePerGbUsd: null, attempt: 1 },
        sermon: { corridor: { sourceInterval: { startMs: 100, endMs: 900 }, detectorVersion: "fixture-coarse-v1",
          evidenceSha256: "b".repeat(64), confidence: 0.5 }, settings: boundaryAsr.settings.extraction },
        structureAudio: { silenceNoiseDb: -45, silenceMinimumMs: 100, waveformWindowSamples: 1600, threads: 1,
          timeoutMs: 30000, maxMetadataBytes: 1048576 },
        structureBoundaries: { paragraphSilenceMinimumMs: 200, splitOnSpeakerChange: true, nonTerminalTokens: [] } };
      if (mode !== "resolved" && mode !== "visual-resolved" && mode !== "visual-http") {
        await expect(prepareSermonSource(prisma, provider, input)).rejects.toThrow(mode === "ambiguous" || visualMode ? "Sermon boundaries remain ambiguous"
          : mode === "document-limit" ? "BOUNDARY_ASR_DOCUMENT_LIMIT" : "BOUNDARY_ASR_RESOLUTION_OUTSIDE_EVIDENCE");
        expect(scribeCalls).toBe(0);
        expect(resolverCalls).toBe(mode === "document-limit" ? 0 : 1);
        expect(await prisma.sermonTranscriptionSubmission.count({ where: { sourceVideoId: f.source.id } })).toBe(0);
        expect(await prisma.processingJob.count({ where: { projectId: f.project.id, type: "ANALYZE" } })).toBe(0);
        if (mode === "ambiguous" || visualMode) {
          const decision = await prisma.derivedMediaArtifact.findFirstOrThrow({ where: { sourceVideoId: f.source.id,
            derivationVersion: mode === "visual-ambiguous" ? "registered-visual-boundary-resolution-v1" : "registered-boundary-resolution-v1" } });
          expect(JSON.parse((await provider.readAsBuffer(decision.storageKey)).toString())).toMatchObject({ resolution: { status: "AMBIGUOUS" } });
          await expect(prepareSermonSource(prisma, provider, input)).rejects.toMatchObject({ code: "SERMON_PREPARATION_REQUIRED", retryable: false });
          const exceptions = await prisma.editorialException.findMany({ where: { projectId: f.project.id,
            exceptionType: "SERMON_PREPARATION_REQUIRED", state: "OPEN" } });
          expect(exceptions).toHaveLength(1);
          expect(exceptions[0].metadata).toMatchObject({ decisionArtifactId: decision.id, automaticRetry: false, fullSourceFallback: false });
          if (visualMode) {
            expect(visualPreparations).toBe(1);
            const refused = mode === "visual-budget" || mode === "visual-image-invalid";
            expect(visualCalls).toBe(refused ? 0 : 1);
            const ledger = await prisma.visualBoundaryEscalation.findUnique({ where: { sourceVideoId: f.source.id } });
            if (refused) expect(ledger).toBeNull();
            else expect(ledger).toMatchObject({ state: mode === "visual-failed" ? "UNCERTAIN" : "COMPLETED" });
            expect(exceptions[0].metadata).toMatchObject({ visualEscalationId: ledger?.id ?? null });
          }
          expect(scribeCalls).toBe(0);

        }
        expect(await readdir(f.request.temporaryRoot)).toEqual([]);
        expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(1);
        return;
      }
      const first = await prepareSermonSource(prisma, provider, input);
      const boundary = first.batch.boundaryAsr!;
      expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(1);
      expect(boundary.corridor).toMatchObject({ sourceInterval: { startMs: 120, endMs: 880 },
        detectorVersion: mode === "visual-http" ? "anthropic-visual-boundary-v1:fixture-v1" : visualMode ? "fixture-visual-v1" : "fixture-resolver-v1" });
      if (visualMode) expect(boundary.decision.artifact.derivationVersion).toBe("registered-visual-boundary-resolution-v1");
      for (const artifact of [boundary.sampling.artifact, boundary.decision.artifact]) {
        expect(artifact).toMatchObject({ publicationState: "READY", retentionClass: "ANALYSIS", expiresAt: batchRetention.analysisExpiresAt });
        const bytes = (await provider.readAsBuffer(artifact.storageKey)).toString();
        expect(bytes).not.toContain(root);
        expect(bytes).not.toContain("wallTimeMs");
        expect(await fileIdentity(provider.absolutePath(artifact.storageKey))).toEqual({ sha256: artifact.sha256, byteCount: Number(artifact.byteCount) });
      }
      const uploads = provider.uploads;
      const repeated = await prepareSermonSource(prisma, provider, input);
      expect(repeated.batch.boundaryAsr!.sampling.artifact.id).toBe(boundary.sampling.artifact.id);
      expect(repeated.batch.boundaryAsr!.decision.artifact.id).toBe(boundary.decision.artifact.id);
      expect(repeated.batch.consumption?.reused).toBe(true);
      expect(scribeCalls).toBe(1);
      expect(visualCalls).toBe(visualMode ? 1 : 0);
      expect(visualPreparations).toBe(visualMode ? 2 : 0);
      expect(provider.uploads).toBe(uploads);
      const facts = (await prisma.operationalEvent.findMany({ where: { projectId: f.project.id, eventType: "processing_cost_fact" } }))
        .map(event => event.metadata as Prisma.JsonObject);
      for (const operation of ["boundary_asr", "boundary_resolution"]) {
        expect(facts.filter(fact => (fact.details as Prisma.JsonObject)?.operation === operation)).toHaveLength(2);
      }
      expect(await readdir(f.request.temporaryRoot)).toEqual([]);
      await prisma.derivedMediaArtifact.updateMany({ where: { id: { in: [boundary.sampling.artifact.id, boundary.decision.artifact.id] } },
        data: { expiresAt: new Date("2020-01-01") } });
      await cleanupExpiredMediaArtifacts(prisma, provider, { workspaceId: f.workspace.id, sourceVideoId: f.source.id,
        ownerId: randomUUID(), maxArtifacts: 10 });
      expect(await provider.exists(boundary.sampling.artifact.storageKey)).toBe(false);
      expect(await provider.exists(boundary.decision.artifact.storageKey)).toBe(false);
      expect(await provider.exists(f.source.storageKey!)).toBe(true);
    }, 60000);

  it.each(["disabled", "selected", "invalid"] as const)("coordinates derivatives, one submission, structure, and post-cleanup analysis handoff (ocr=%s)", async ocrMode => {
    const f = await fixture();
    await writeMedia(f.source.storageKey!);
    let calls = 0;
    const scribe = new ScribeTranscriptionProvider({ apiKey: "fixture-only", request: async () => {
      calls++;
      const ready = await prisma.derivedMediaArtifact.findMany({ where: { sourceVideoId: f.source.id, publicationState: "READY" } });
      expect(ready.map(artifact => artifact.kind)).toEqual(expect.arrayContaining(["ANALYSIS_AUDIO", "SOURCE_PROXY", "LOCAL_EVIDENCE", "SERMON_AUDIO"]));
      if (ocrMode === "selected") expect(ready.some(artifact => artifact.derivationVersion === "registered-sparse-ocr-v1")).toBe(true);
      expect(await prisma.transcript.findUnique({ where: { sourceVideoId: f.source.id } })).toBeNull();
      return { language_code: "en", text: "Hello.", words: [
        { type: "word", text: "Hello.", start: 0.1, end: 0.5, speaker_id: "one", logprob: -0.1 },
      ] };
    } });
    const checked = prisma.$extends({ query: { processingJob: { async upsert({ args, query }) {
      if (args.create.projectId === f.project.id) {
        expect(await prisma.sourceMediaSession.count({ where: { sourceId: f.source.id, state: { not: "COMPLETE" } } })).toBe(0);
        expect(await readdir(f.request.temporaryRoot)).toEqual([]);
      }
      return query(args);
    } } } }) as unknown as PrismaClient;
    const input = { request: f.request, projectId: f.project.id, derivatives: batchSettings, retention: batchRetention,
      localEvidence: evidenceSettings, provider: scribe,
      ocr: ocrMode === "disabled" ? undefined : await makeOcrRequest(f.source.id, ocrMode === "invalid" ? "unknown-selection" : "success"),
      storageAccounting: { provider: "local" as const, downloadPricePerGbUsd: null, uploadPricePerGbUsd: null, attempt: 1 },
      sermon: { corridor: { sourceInterval: { startMs: 100, endMs: 900 }, detectorVersion: "fixture-only-v1",
        evidenceSha256: "b".repeat(64), confidence: 0.9 }, settings: { threads: 1, flacCompressionLevel: 5,
        timeoutMs: 30000, maxMetadataBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 } },
      structureAudio: { silenceNoiseDb: -45, silenceMinimumMs: 100, waveformWindowSamples: 1600, threads: 1,
        timeoutMs: 30000, maxMetadataBytes: 1024 * 1024 },
      structureBoundaries: { paragraphSilenceMinimumMs: 200, splitOnSpeakerChange: true, nonTerminalTokens: [] } };
    if (ocrMode === "invalid") {
      await expect(prepareSermonSource(checked, provider, input)).rejects.toThrow("OCR_SELECTION_NOT_REPRESENTATIVE");
      expect(calls).toBe(0);
      expect(await prisma.sermonTranscriptionSubmission.count({ where: { sourceVideoId: f.source.id } })).toBe(0);
      expect(await prisma.transcript.findUnique({ where: { sourceVideoId: f.source.id } })).toBeNull();
      expect(await prisma.processingJob.count({ where: { projectId: f.project.id, type: "ANALYZE" } })).toBe(0);
      expect(await readdir(f.request.temporaryRoot)).toEqual([]);
      const events = await prisma.operationalEvent.findMany({ where: { projectId: f.project.id, eventType: "processing_cost_fact" } });
      expect(events.map(event => event.metadata)).toContainEqual(expect.objectContaining({
        outcome: "failed", stage: "analysis_classification", details: expect.objectContaining({ operation: "sparse_ocr" }),
      }));
      return;
    }
    const first = await prepareSermonSource(checked, provider, input);
    if (ocrMode === "selected") expect(first.batch.ocr?.artifact.publicationState).toBe("READY");
    expect(first.transcript).toMatchObject({ reused: false, transcriptRevision: 1 });
    expect(first.batch.consumption).toMatchObject({ reused: false });
    expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(1);
    expect(await prisma.sourceMediaSession.findUnique({ where: { id: first.batch.sessionId } })).toMatchObject({ state: "COMPLETE" });
    const repeated = await prepareSermonSource(checked, provider, input);
    expect(repeated.transcript).toEqual({ ...first.transcript, reused: true });
    expect(repeated.batch.consumption?.reused).toBe(true);
    expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(2);
    expect(calls).toBe(1);
    const facts = (await prisma.operationalEvent.findMany({ where: { workspaceId: f.workspace.id, eventType: "processing_cost_fact" } }))
      .map(event => event.metadata as Prisma.JsonObject);
    expect(facts.filter(fact => fact.stage === "transcription")).toHaveLength(1);
    const artifactCount = await prisma.derivedMediaArtifact.count({ where: { sourceVideoId: f.source.id } });
    expect(artifactCount).toBeGreaterThanOrEqual(4);
    expect(facts.filter(fact => fact.stage === "upload")).toHaveLength(artifactCount);
    expect(facts.filter(fact => fact.stage === "download")).toHaveLength(2 * (artifactCount + 1));
    expect(facts.every(fact => fact.outcome === "succeeded")).toBe(true);
    expect(facts.filter(fact => fact.stage === "download" || fact.stage === "upload").every(fact =>
      fact.pricingStatus === "zero_cost" && typeof fact.bytes === "number" && fact.bytes > 0)).toBe(true);
    const computation = facts.filter(fact => fact.provider === "local_media_worker");
    expect(computation).toHaveLength(ocrMode === "selected" ? 12 : 10);
    expect(computation.every(fact => fact.pricingStatus === "unpriced" && fact.cpuTimeMs === null &&
      typeof fact.wallTimeMs === "number" && fact.wallTimeMs > 0)).toBe(true);
    expect(computation.map(fact => (fact.details as Prisma.JsonObject).operation).sort()).toEqual([
      "analysis_derivatives", "analysis_derivatives", "local_evidence", "local_evidence",
      "representative_frames", "representative_frames", "sermon_audio", "sermon_audio",
      "transcript_structure", "transcript_structure",
      ...(ocrMode === "selected" ? ["sparse_ocr", "sparse_ocr"] : []),
    ].sort());
    // Exercise the actual PROBE switch with the same completed submission and real artifacts.
    const previous = process.env.P4_SERMON_PREPARATION_ENABLED;
    const storageSpy = vi.spyOn(storageModule, "getStorageProvider").mockReturnValue(provider);
    const providerSpy = vi.spyOn(transcriptionModule, "resolveTranscriptionProviders").mockReturnValue({
      primary: scribe, fallback: null, policy: { primary: "scribe", fallback: null },
    });
    try {
      process.env.P4_SERMON_PREPARATION_ENABLED = "true";
      await prisma.project.update({ where: { id: f.project.id }, data: { processingConfig: {
        sermonPreparation: JSON.parse(JSON.stringify({ version: "sermon-preparation-v1", derivatives: input.derivatives,
          localEvidence: input.localEvidence, sermon: input.sermon, structureAudio: input.structureAudio,
          structureBoundaries: input.structureBoundaries, retention: input.retention })),
      } } });
      const probeJob = await prisma.processingJob.update({ where: { id: f.job.id }, data: { type: "PROBE" } });
      const prepared = await runProbeJob({ prisma, job: probeJob });
      expect(prepared?.metadata).toMatchObject({ preparationVersion: "sermon-preparation-v1",
        submissionId: first.batch.consumption!.submissionId });
      expect(calls).toBe(1);
      expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(3);
      expect(await prisma.processingJob.count({ where: { projectId: f.project.id, type: "TRANSCRIBE" } })).toBe(0);
      expect(await prisma.sourceVideo.findUnique({ where: { id: f.source.id } })).toMatchObject({ audioKey: null, thumbnailKey: null });
    } finally {
      storageSpy.mockRestore(); providerSpy.mockRestore();
      if (previous === undefined) delete process.env.P4_SERMON_PREPARATION_ENABLED;
      else process.env.P4_SERMON_PREPARATION_ENABLED = previous;
    }
    expect(await prisma.sourceVideo.findUnique({ where: { id: f.source.id } })).toMatchObject({ width: 1920, height: 1080 });
  }, 30000);

  it.each([false, true])("connects registered sermon audio to durable Scribe requests and cost facts (failure=%s)", async failure => {
    const f = await fixture();
    await writeMedia(f.source.storageKey!);
    let calls = 0;
    await withMaterializedSource(prisma, provider, f.request, async source => {
      const built = await buildAnalysisDerivatives(source, batchSettings);
      const audio = await extractSermonAudio({ path: built.analysis.path, sha256: built.analysis.sha256,
        byteCount: built.analysis.byteCount, sourceInterval: built.analysis.sourceInterval }, {
        sourceInterval: { startMs: 100, endMs: 900 }, detectorVersion: "fixture-only-v1", evidenceSha256: "b".repeat(64), confidence: 0.9,
      }, source.directory, { threads: 1, flacCompressionLevel: 5, timeoutMs: 30000, maxMetadataBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 });
      const identity = { sourceVideoId: source.sourceVideoId, sourceSha256: source.sha256, kind: "SERMON_AUDIO" as const,
        sourceInterval: audio.evidence.corridor.sourceInterval, derivationVersion: audio.evidence.version,
        configurationSha256: audio.evidenceSha256 };
      const { artifact } = await publishMediaArtifact(prisma, provider,
        { workspaceId: f.workspace.id, sessionId: source.sessionId, ownerId: f.request.ownerId }, {
          ...identity, storageKey: `sources/${source.sourceVideoId}/artifacts/${artifactIdentityKey(identity)}.flac`,
          sha256: audio.sha256, byteCount: BigInt(audio.byteCount), retentionClass: "ANALYSIS", expiresAt: null,
          mappingStatus: "VERIFIED", mappingEvidenceSha256: rangeEvidenceSha256({ parent: built.analysis.mappingEvidenceSha256,
            trim: audio.evidenceSha256 }), visualQuality: "NOT_APPLICABLE",
        }, audio.path, "audio/flac", { trimEvidence: audio.evidence, analysisMappingEvidence: built.analysis.mappingEvidence });
      const scribe = new ScribeTranscriptionProvider({ apiKey: "fixture-only", request: async () => {
        calls++;
        if (failure) throw new Error("Fixture provider outcome unknown");
        return { language_code: "en", text: "Hello.", words: [
          { type: "word", text: "Hello.", start: 0.1, end: 0.5, speaker_id: "one", logprob: -0.1 },
        ] };
      } });
      const request = { workspaceId: f.workspace.id, sourceVideoId: f.source.id, sourceSha256: source.sha256,
        artifactId: artifact.id, sessionId: source.sessionId, ownerId: f.request.ownerId,
        analysis: built.analysis, audio, provider: scribe };
      if (failure) {
        await expect(transcribeRegisteredSermonAudio(prisma, request)).rejects.toThrow("Fixture provider outcome unknown");
        await expect(transcribeRegisteredSermonAudio(prisma, request)).rejects.toThrow("SERMON_SUBMISSION_UNCERTAIN");
      } else {
        const first = await transcribeRegisteredSermonAudio(prisma, request);
        const repeated = await transcribeRegisteredSermonAudio(prisma, request);
        expect(first.reused).toBe(false);
        expect(repeated).toEqual({ ...first, reused: true });
        expect(first.provenance).toMatchObject({ submittedDurationMs: 800, sourceOffsetMs: 100,
          sourceSha256: source.sha256, submittedAudioSha256: artifact.sha256 });
        expect(first.result).toMatchObject({ result: { segments: [{ words: [{ startMs: 200, endMs: 600 }] }] } });
        const structure = await buildSubmissionTranscriptStructure(prisma, { workspaceId: f.workspace.id, submissionId: first.submissionId,
          audioPath: audio.path, byteCount: audio.byteCount,
          audioSettings: { silenceNoiseDb: -45, silenceMinimumMs: 100, waveformWindowSamples: 1600, threads: 1,
            timeoutMs: 30000, maxMetadataBytes: 1024 * 1024 },
          boundarySettings: { paragraphSilenceMinimumMs: 200, splitOnSpeakerChange: true, nonTerminalTokens: [] } });
        const persistRequest = { workspaceId: f.workspace.id, projectId: f.project.id, submissionId: first.submissionId, structure };
        await expect(persistSermonSubmission(prisma, { ...persistRequest, structure: { ...structure,
          audioEvidence: { ...structure.audioEvidence, inputSha256: "d".repeat(64) } } })).rejects.toThrow("AUDIO_MISMATCH");
        await expect(persistSermonSubmission(prisma, { ...persistRequest, structure: { ...structure,
          boundaries: { ...structure.boundaries, sentences: [] } } })).rejects.toThrow("BOUNDARIES_CHANGED");
        const broken = prisma.$extends({ query: { processingJob: { async upsert({ args, query }) {
          if (args.create.projectId === f.project.id) throw new Error("Fixture handoff failure");
          return query(args);
        } } } }) as unknown as PrismaClient;
        await expect(persistSermonSubmission(broken, persistRequest)).rejects.toThrow("Fixture handoff failure");
        expect(await prisma.transcript.findUnique({ where: { sourceVideoId: f.source.id } })).toBeNull();
        expect(await prisma.sourceVideo.findUnique({ where: { id: f.source.id } })).toMatchObject({ transcriptRevision: 0 });
        const persisted = await persistSermonSubmission(prisma, persistRequest);
        expect(persisted).toMatchObject({ reused: false, transcriptRevision: 1 });
        expect(await persistSermonSubmission(prisma, persistRequest)).toEqual({ ...persisted, reused: true });
        const stored = await prisma.transcript.findUniqueOrThrow({ where: { sourceVideoId: f.source.id }, include: { segments: true } });
        expect(stored).toMatchObject({ id: persisted.transcriptId, fullText: "Hello.",
          provenance: { ...first.provenance, capabilities: { ...first.provenance.capabilities, ...structure.boundaries.capabilities } },
          capabilities: { ...first.provenance.capabilities, ...structure.boundaries.capabilities }, structure,
          providerEvidence: { submissionId: first.submissionId }, segments: [{ startMs: 200, endMs: 600 }] });
        expect(await prisma.processingJob.count({ where: { projectId: f.project.id, type: "ANALYZE" } })).toBe(1);
        expect(stored.structure).toMatchObject({ boundaries: { sentences: [{ startMs: 200, endMs: 600 }],
          paragraphs: [{ startMs: 200, endMs: 600 }] } });
        const changedStructure = await buildSubmissionTranscriptStructure(prisma, { workspaceId: f.workspace.id, submissionId: first.submissionId,
          audioPath: audio.path, byteCount: audio.byteCount, audioSettings: structure.audioEvidence.settings,
          boundarySettings: { ...structure.settings, paragraphSilenceMinimumMs: 300 } });
        await expect(persistSermonSubmission(prisma, { ...persistRequest, structure: changedStructure })).rejects.toThrow("STRUCTURE_CONFLICT");
        await expect(persistSermonSubmission(prisma, { ...persistRequest, workspaceId: randomUUID() })).rejects.toThrow("PROJECT_NOT_FOUND");
        const originalSubmission = await prisma.sermonTranscriptionSubmission.findUniqueOrThrow({ where: { id: first.submissionId } });
        const stale = await prisma.sermonTranscriptionSubmission.create({ data: { sourceVideoId: f.source.id, artifactId: artifact.id,
          requestIdentity: rangeEvidenceSha256(randomUUID()), requestEvidence: originalSubmission.requestEvidence as Prisma.InputJsonObject } });
        await prisma.sermonTranscriptionSubmission.update({ where: { id: stale.id }, data: { state: "COMPLETED", finishedAt: new Date(),
          result: originalSubmission.result as Prisma.InputJsonObject, resultSha256: originalSubmission.resultSha256 } });
        await expect(persistSermonSubmission(prisma, { ...persistRequest, submissionId: stale.id })).rejects.toMatchObject({ code: "TRANSCRIPT_CHANGED", retryable: false });
        expect(await prisma.transcript.findUnique({ where: { sourceVideoId: f.source.id } })).toMatchObject({ id: persisted.transcriptId });
        const currentSource = await prisma.sourceVideo.findUniqueOrThrow({ where: { id: f.source.id } });
        const changedSource = await prisma.sermonTranscriptionSubmission.create({ data: { sourceVideoId: f.source.id, artifactId: artifact.id,
          requestIdentity: rangeEvidenceSha256(randomUUID()), requestEvidence: { ...(originalSubmission.requestEvidence as Prisma.InputJsonObject),
            transcriptRevision: currentSource.transcriptRevision, sourceUpdatedAt: currentSource.updatedAt.toISOString() } } });
        await prisma.sermonTranscriptionSubmission.update({ where: { id: changedSource.id }, data: { state: "COMPLETED", finishedAt: new Date(),
          result: originalSubmission.result as Prisma.InputJsonObject, resultSha256: originalSubmission.resultSha256 } });
        await prisma.sourceVideo.update({ where: { id: f.source.id }, data: { filename: "changed-source.mov",
          updatedAt: new Date(currentSource.updatedAt.getTime() + 1000) } });
        await expect(persistSermonSubmission(prisma, { ...persistRequest, submissionId: changedSource.id }))
          .rejects.toMatchObject({ code: "TRANSCRIPT_CHANGED", retryable: false });
      }
      expect(calls).toBe(1);
      const facts = await prisma.operationalEvent.findMany({ where: { workspaceId: f.workspace.id, eventType: "processing_cost_fact" } });
      expect(facts).toHaveLength(1);
      expect((facts[0].metadata as Prisma.JsonObject).quantity).toBeCloseTo(800 / 60000, 15);
      expect(facts[0].metadata).toMatchObject({ stage: "transcription", unit: "minute",
        bytes: audio.byteCount, attempt: 1, outcome: failure ? "failed" : "succeeded",
        details: { artifactId: artifact.id, submittedDurationMs: 800, sourceOffsetMs: 100, keytermsCount: 0 } });
    });
  }, 30000);

  it("registers sermon-only audio inside the shared source acquisition", async () => {
    const f = await fixture();
    await writeMedia(f.source.storageKey!);
    const result = await runAnalysisDerivativeBatch(prisma, provider, f.request, batchSettings, batchRetention, undefined, {
      corridor: { sourceInterval: { startMs: 123, endMs: 789 }, detectorVersion: "fixture-only-v1",
        evidenceSha256: "b".repeat(64), confidence: 0.9 },
      settings: { threads: 1, flacCompressionLevel: 5, timeoutMs: 30000,
        maxMetadataBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 },
    });
    expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(1);
    expect(result.sermon?.artifact).toMatchObject({ kind: "SERMON_AUDIO", publicationState: "READY", mappingStatus: "VERIFIED",
      startMs: BigInt(123), endMs: BigInt(789), retentionClass: "ANALYSIS", expiresAt: batchRetention.analysisExpiresAt,
      publicationEvidence: { derivation: { analysisArtifactId: result.analysis.artifact.id,
        trimEvidence: { sourceOffsetMs: 123, durationMs: 666, sampleCount: 10656 } } } });
    const artifact = result.sermon!.artifact;
    expect(await fileIdentity(provider.absolutePath(artifact.storageKey))).toEqual({
      sha256: artifact.sha256, byteCount: Number(artifact.byteCount) });
    expect(await readdir(f.request.temporaryRoot)).toEqual([]);
    await prisma.derivedMediaArtifact.update({ where: { id: artifact.id }, data: { expiresAt: new Date("2020-01-01") } });
    await cleanupExpiredMediaArtifacts(prisma, provider, { workspaceId: f.workspace.id, sourceVideoId: f.source.id,
      ownerId: randomUUID(), maxArtifacts: 10 });
    expect(await provider.exists(artifact.storageKey)).toBe(false);
  }, 30000);

  async function makeOcrRequest(sourceVideoId: string, mode: string): Promise<AnalysisBatchOcrRequest> {
    const modelRoot = path.join(root, `ocr-model-${randomUUID()}`);
    await mkdir(modelRoot);
    const modelFile = path.join(modelRoot, "eng.traineddata");
    await writeFile(modelFile, "synthetic model fixture, not real weights");
    const modelIdentity = await fileIdentity(modelFile);
    const binary = path.join(modelRoot, "ocr-fixture");
    // This executable simulates OCR only. The batch still builds, verifies, and stores real media.
    const tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t20\t40\t30\t95\tFixture\n";
    await writeFile(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'tesseract fixture\\n'; else printf '%s' '${tsv}'; fi\n`, { mode: 0o700 });
    return {
      maxDocumentBytes: mode === "document-limit" ? 1 : 1024 * 1024,
      settings: { binaryPath: binary, modelRoot, usage: "evaluation", pageSegmentationMode: 6,
        maxSelectedFrames: 1, maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, timeoutMs: 30000,
        model: { modelId: "fixture", version: "v1", roles: ["OCR"], relativePath: "eng.traineddata", ...modelIdentity,
          upstreamRevision: "fixture", sourceUrl: "https://example.test/model",
          license: { spdx: "MIT", codeEvidenceUrl: "https://example.test/license", weightsEvidenceUrl: "https://example.test/weights",
            reviewStatus: "REVIEWED_FOR_EVALUATION", reviewReference: "fixture-only" },
          productionApproval: { approved: false, evaluationEvidenceSha256: null, decisionReference: null } } },
      select: async context => {
        expect(JSON.parse(await readFile(context.localEvidencePath, "utf8"))).toMatchObject({ sourceVideoId });
        expect(context.frames).toHaveLength(1);
        return [{ groupIndex: mode === "unknown-selection" ? 999 : context.frames[0].groupIndex,
          frameSha256: context.frames[0].sha256, decision: "LIKELY_STATIC_TEXT", evidenceSha256: "a".repeat(64) }];
      },
    };
  }

  it.each(["success", "missing-representatives", "unknown-selection", "document-limit"] as const)(
    "registers sparse OCR in the source batch (%s)", async mode => {
      const f = await fixture();
      await writeMedia(f.source.storageKey!);
      const ocrRequest = await makeOcrRequest(f.source.id, mode);
      const run = () => runAnalysisDerivativeBatch(prisma, provider, f.request, batchSettings, batchRetention,
        mode === "missing-representatives" ? { ...evidenceSettings, representatives: undefined } : evidenceSettings,
        undefined, undefined, undefined, [], ocrRequest);
      if (mode !== "success") {
        await expect(run()).rejects.toThrow(mode === "missing-representatives" ? "OCR_REPRESENTATIVE_SETTINGS_REQUIRED"
          : mode === "unknown-selection" ? "OCR_SELECTION_NOT_REPRESENTATIVE" : "OCR_DOCUMENT_LIMIT_EXCEEDED");
        expect(await prisma.derivedMediaArtifact.count({ where: { sourceVideoId: f.source.id,
          derivationVersion: "registered-sparse-ocr-v1" } })).toBe(0);
        expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(mode === "missing-representatives" ? 0 : 1);
        return;
      }
      const result = await run();
      expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(1);
      const artifact = result.ocr!.artifact;
      expect(artifact).toMatchObject({ kind: "LOCAL_EVIDENCE", publicationState: "READY", retentionClass: "ANALYSIS",
        expiresAt: batchRetention.analysisExpiresAt, derivationVersion: "registered-sparse-ocr-v1" });
      const bytes = await provider.readAsBuffer(artifact.storageKey);
      const document = JSON.parse(bytes.toString());
      expect(document).toMatchObject({ localEvidenceArtifactId: result.localEvidence!.artifact.id,
        frameArtifacts: [{ artifactId: result.representatives[0].artifact.id }],
        ocr: { selectedFrames: 1, results: [{ words: [{ text: "Fixture" }] }] } });
      expect(bytes.toString()).not.toContain(root);
      expect(bytes.toString()).not.toContain("wallTimeMs");
      expect(await fileIdentity(provider.absolutePath(artifact.storageKey))).toEqual({ sha256: artifact.sha256,
        byteCount: Number(artifact.byteCount) });
      const uploads = provider.uploads;
      const repeated = await run();
      expect(repeated.ocr!.artifact.id).toBe(artifact.id);
      expect(provider.uploads).toBe(uploads);
      expect(await readdir(f.request.temporaryRoot)).toEqual([]);
      await prisma.derivedMediaArtifact.update({ where: { id: artifact.id }, data: { expiresAt: new Date("2020-01-01") } });
      await cleanupExpiredMediaArtifacts(prisma, provider, { workspaceId: f.workspace.id, sourceVideoId: f.source.id,
        ownerId: randomUUID(), maxArtifacts: 10 });
      expect(await provider.exists(artifact.storageKey)).toBe(false);
      expect(await prisma.derivedMediaArtifact.findUnique({ where: { id: artifact.id } })).toMatchObject({ deletedAt: expect.any(Date) });
      expect(await provider.exists(f.source.storageKey!)).toBe(true);
    }, 60000);

  it("publishes real derivatives and all local evidence under one source acquisition", async () => {
    const f = await fixture();
    await writeMedia(f.source.storageKey!);
    const result = await runAnalysisDerivativeBatch(prisma, provider, f.request, batchSettings, batchRetention, evidenceSettings);
    expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(1);
    expect(result.analysis.artifact).toMatchObject({ kind: "ANALYSIS_AUDIO", publicationState: "READY",
      retentionClass: "ANALYSIS", expiresAt: batchRetention.analysisExpiresAt, mappingStatus: "VERIFIED",
      publicationEvidence: { derivation: { output: { audio: { codec: "flac", sampleRateHz: 16000, channels: 1 } } } } });
    expect(result.proxy.artifact).toMatchObject({ kind: "SOURCE_PROXY", publicationState: "READY",
      retentionClass: "PREVIEW", expiresAt: batchRetention.previewExpiresAt, visualQuality: "NOT_REVIEWED",
      publicationEvidence: { derivation: { output: { video: { codec: "h264", height: 480 } },
        original: { video: { width: 1920, height: 1080 } }, settings: batchSettings } } });
    for (const artifact of [result.analysis.artifact, result.proxy.artifact]) {
      expect(artifact.publicationSessionId).toBe(result.sessionId);
      expect(artifact.sourceSha256).toBe(result.sourceSha256);
      expect(await fileIdentity(provider.absolutePath(artifact.storageKey))).toEqual({
        sha256: artifact.sha256, byteCount: Number(artifact.byteCount),
      });
    }
    expect(await prisma.sourceMediaSession.findUnique({ where: { id: result.sessionId } })).toMatchObject({ state: "COMPLETE" });
    expect(await prisma.sourceVideo.findUnique({ where: { id: f.source.id } })).toMatchObject({ width: 1920, height: 1080 });
    expect(await readdir(f.request.temporaryRoot)).toEqual([]);
    expect(result.representatives).toHaveLength(1);
    expect(result.representatives[0]).toMatchObject({ sourceTimeMs: 0, groupIndex: 0, sampleIndex: 0,
      artifact: { kind: "SPARSE_FRAME", publicationState: "READY", retentionClass: "ANALYSIS",
        expiresAt: batchRetention.analysisExpiresAt, publicationSessionId: result.sessionId,
        startMs: BigInt(0), endMs: BigInt(1), mappingStatus: "DECLARED", visualQuality: "NOT_REVIEWED",
        publicationEvidence: { derivation: { proxyArtifactId: result.proxy.artifact.id,
          width: 854, height: 480, verification: "decoded-bgra-sha256-equal" } } } });
    expect(await fileIdentity(provider.absolutePath(result.representatives[0].artifact.storageKey))).toEqual({
      sha256: result.representatives[0].artifact.sha256, byteCount: Number(result.representatives[0].artifact.byteCount),
    });
    const registeredEvidence = result.localEvidence!.artifact;
    expect(registeredEvidence).toMatchObject({ kind: "LOCAL_EVIDENCE", publicationState: "READY", retentionClass: "ANALYSIS",
      publicationSessionId: result.sessionId, expiresAt: batchRetention.analysisExpiresAt, mappingStatus: "DECLARED",
      publicationEvidence: { derivation: { analysisArtifactId: result.analysis.artifact.id,
        proxyArtifactId: result.proxy.artifact.id, counts: { waveformWindows: 10, videoFrames: 25, sparseFrames: 2, representativeGroups: 1 } } } });
    const evidenceBytes = await provider.readAsBuffer(registeredEvidence.storageKey);
    const document = JSON.parse(evidenceBytes.toString("utf8"));
    expect(document).toMatchObject({ schemaVersion: "local-evidence-document-v1", sourceVideoId: f.source.id,
      sourceSha256: result.sourceSha256, audio: { totalSamples: 16000, waveform: expect.any(Array), silence: expect.any(Array) },
      video: { scenes: expect.any(Array), black: expect.any(Array), freeze: expect.any(Array), motion: expect.any(Array) },
      frames: { samples: expect.any(Array) }, grouping: { groups: [{ representativeIndex: 0, memberIndices: [0, 1] }] } });
    expect(document.frames.settings.maxFrames).toBeUndefined();
    expect(document.audio.settings.timeoutMs).toBeUndefined();
    expect(await fileIdentity(provider.absolutePath(registeredEvidence.storageKey))).toEqual({
      sha256: registeredEvidence.sha256, byteCount: Number(registeredEvidence.byteCount),
    });
    const uploads = provider.uploads;
    const repeated = await runAnalysisDerivativeBatch(prisma, provider, f.request, batchSettings, batchRetention,
      { ...evidenceSettings, audio: { ...evidenceSettings.audio, timeoutMs: 60000 },
        frames: { ...evidenceSettings.frames, maxFrames: 200 }, maxDocumentBytes: 2 * 1024 * 1024 });
    expect(repeated.localEvidence!.artifact.id).toBe(registeredEvidence.id);
    expect(await provider.readAsBuffer(repeated.localEvidence!.artifact.storageKey)).toEqual(evidenceBytes);
    expect(repeated.representatives[0].artifact.id).toBe(result.representatives[0].artifact.id);
    expect(repeated.analysis.artifact.id).toBe(result.analysis.artifact.id);
    expect(repeated.proxy.artifact.id).toBe(result.proxy.artifact.id);
    expect(repeated.sessionId).not.toBe(result.sessionId);
    expect(provider.uploads).toBe(uploads);
    expect(provider.downloadKeys.filter(key => key === f.source.storageKey)).toHaveLength(2);
  }, 30000);

  it("keeps completed media and an uncertain session when evidence exceeds its document limit", async () => {
    const f = await fixture();
    await writeMedia(f.source.storageKey!);
    await expect(runAnalysisDerivativeBatch(prisma, provider, f.request, batchSettings, batchRetention,
      { ...evidenceSettings, maxDocumentBytes: 10 })).rejects.toThrow("MEDIA_LOCAL_EVIDENCE_DOCUMENT_LIMIT_EXCEEDED");
    const artifacts = await prisma.derivedMediaArtifact.findMany({ where: { sourceVideoId: f.source.id } });
    expect(artifacts).toHaveLength(2);
    expect(artifacts.every(artifact => artifact.publicationState === "READY")).toBe(true);
    expect(await prisma.sourceMediaSession.findFirst({ where: { sourceId: f.source.id } })).toMatchObject({ state: "UNCERTAIN" });
    expect(await readdir(f.request.temporaryRoot)).toEqual([]);
  });

  it("retains the completed output and pending ownership when the second publication fails", async () => {
    const f = await fixture();
    await writeMedia(f.source.storageKey!);
    const unavailable = Object.create(provider) as LocalDiskStorageProvider;
    let writes = 0;
    unavailable.uploadFileIfAbsent = async (key, file) => {
      if (++writes === 2) throw new Error("fixture proxy upload failed");
      await provider.uploadFileIfAbsent(key, file);
    };
    await expect(runAnalysisDerivativeBatch(prisma, unavailable, f.request, batchSettings, batchRetention))
      .rejects.toThrow("fixture proxy upload failed");
    const rows = await prisma.derivedMediaArtifact.findMany({ where: { sourceVideoId: f.source.id }, orderBy: { kind: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "ANALYSIS_AUDIO", publicationState: "READY" });
    expect(rows[1]).toMatchObject({ kind: "SOURCE_PROXY", publicationState: "PENDING" });
    expect(await provider.exists(rows[0].storageKey)).toBe(true);
    expect(await provider.exists(rows[1].storageKey)).toBe(false);
    expect(await prisma.sourceMediaSession.findUnique({ where: { id: rows[0].publicationSessionId! } }))
      .toMatchObject({ state: "UNCERTAIN", terminalEvidence: { pendingPublications: 1 } });
    expect(await readdir(f.request.temporaryRoot)).toEqual([]);
  });

  it("builds real audio and proxy outputs under one source acquisition", async () => {
    const f = await fixture();
    await promisify(execFile)("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
      "color=black:s=1920x1080:d=1:r=25", "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-c:a", "aac", "-shortest",
      "-f", "mp4", provider.absolutePath(f.source.storageKey!)], { timeout: 30000 });
    const before = provider.downloads;
    let outputDirectory = "";
    await withMaterializedSource(prisma, provider, f.request, async source => {
      const built = await buildAnalysisDerivatives(source, {
        proxyCrf: 18, proxyPreset: "ultrafast", proxyAudioBitrateBps: 64000,
        flacCompressionLevel: 5, encoderThreads: 1, timeoutMs: 30000,
      });
      outputDirectory = path.dirname(built.analysis.path);
      expect(built.analysis.facts.audio).toMatchObject({ codec: "flac", channels: 1, sampleRateHz: 16000 });
      expect(built.proxy.facts.video).toMatchObject({ codec: "h264", height: 480 });
      expect(built.original.video).toMatchObject({ width: 1920, height: 1080 });
    });
    expect(provider.downloads - before).toBe(1);
    await expect(readdir(outputDirectory)).rejects.toThrow();
    expect(await prisma.sourceVideo.findUnique({ where: { id: f.source.id } })).toMatchObject({ width: 1920, height: 1080 });
  });

  it("does not admit another workspace or write its session history", async () => {
    const f = await fixture();
    await expect(withMaterializedSource(prisma, provider, { ...f.request, workspaceId: randomUUID() }, async () => {}))
      .rejects.toThrow("MEDIA_SOURCE_NOT_FOUND");
    expect(await prisma.sourceMediaSession.count({ where: { sourceId: f.source.id } })).toBe(0);
  });

  it("waits for retention's source lock and refuses admission after deletion", async () => {
    const f = await fixture();
    await prisma.sourceMediaGate.create({ data: { sourceId: f.source.id } });
    const storage = getStorageProvider();
    const originalRemove = storage.remove.bind(storage);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    storage.remove = async key => {
      if (key === f.source.storageKey) { entered(); await proceed; }
      return originalRemove(key);
    };
    const cleanup = runCleanupJob({ prisma, job: f.job });
    try {
      await started;
      await expect(secondClient.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'");
        return tx.$queryRaw`SELECT source_id FROM source_media_gates WHERE source_id = ${f.source.id}::uuid FOR UPDATE`;
      })).rejects.toThrow();
      const before = provider.downloads;
      const admission = withMaterializedSource(secondClient, provider, f.request, async () => "must not run")
        .then(value => ({ value }), error => ({ error }));
      release();
      await cleanup;
      expect(await admission).toMatchObject({ error: new Error("MEDIA_SOURCE_NOT_RENDERABLE") });
      expect(provider.downloads).toBe(before);
    } finally {
      release();
      storage.remove = originalRemove;
      await cleanup;
    }
  });

  it("does not reclaim an old unfinished session based only on age", async () => {
    const f = await fixture();
    const sessionId = randomUUID();
    await prisma.$transaction(async tx => {
      await tx.sourceMediaGate.create({ data: { sourceId: f.source.id } });
      await tx.sourceMediaSession.create({ data: {
        id: sessionId, sourceId: f.source.id, generation: BigInt(0), ownerId: randomUUID(),
        purpose: "P4_DERIVATIVE_BUILD", createdAt: new Date("2000-01-01"), updatedAt: new Date("2000-01-01"),
      } });
      await tx.cleanupAuditEvent.create({ data: {
        id: randomUUID(), targetType: "session", targetId: sessionId, revision: BigInt(0), action: "ACTIVE",
        actorId: f.request.ownerId, evidence: { fixture: "old unfinished session" },
      } });
    });
    await expect(withMaterializedSource(prisma, provider, f.request, async () => {})).rejects.toBeInstanceOf(SourceMediaBusyError);
    await runCleanupJob({ prisma, job: f.job });
    expect(await provider.exists(f.source.storageKey!)).toBe(true);
    expect(await prisma.sourceMediaSession.findUnique({ where: { id: sessionId } })).toMatchObject({ state: "ACTIVE" });
  });

  it("settles an acquisition failure before callback work and permits an explicit later attempt", async () => {
    const f = await fixture();
    provider.fail = true;
    try {
      await expect(withMaterializedSource(prisma, provider, f.request, async () => { throw new Error("Must not run"); }))
        .rejects.toThrow("Fixture acquisition failure");
    } finally { provider.fail = false; }
    const session = await prisma.sourceMediaSession.findFirstOrThrow({ where: { sourceId: f.source.id } });
    expect(session).toMatchObject({ state: "COMPLETE", terminalEvidence: { callbackStarted: false, temporaryFilesRemoved: true } });
    expect(await withMaterializedSource(prisma, provider, f.request, async () => "retry result")).toBe("retry result");
  });

  it("preserves uncertain callback work without an automatic retry or retention deletion", async () => {
    const f = await fixture();
    await expect(withMaterializedSource(prisma, provider, f.request, async () => { throw new Error("Fixture callback failure"); }))
      .rejects.toThrow("Fixture callback failure");
    const session = await prisma.sourceMediaSession.findFirstOrThrow({ where: { sourceId: f.source.id } });
    expect(session).toMatchObject({ state: "UNCERTAIN", terminalEvidence: { callbackStarted: true, callbackSucceeded: false, temporaryFilesRemoved: true } });
    await expect(withMaterializedSource(secondClient, provider, f.request, async () => {})).rejects.toBeInstanceOf(SourceMediaBusyError);
    await runCleanupJob({ prisma, job: f.job });
    expect(await provider.exists(f.source.storageKey!)).toBe(true);
  });

  it("does not let a missing audit authorize a session state change", async () => {
    const f = await fixture();
    await expect(withMaterializedSource(prisma, provider, f.request, async () => { throw new Error("Keep uncertain"); })).rejects.toThrow();
    const session = await prisma.sourceMediaSession.findFirstOrThrow({ where: { sourceId: f.source.id } });
    await expect(prisma.sourceMediaSession.update({ where: { id: session.id }, data: {
      state: "COMPLETE", revision: BigInt(2), updatedAt: new Date(), terminalEvidence: { invented: true },
    } })).rejects.toThrow();
    expect(await prisma.sourceMediaSession.findUnique({ where: { id: session.id } })).toMatchObject({ state: "UNCERTAIN" });
  });
});
