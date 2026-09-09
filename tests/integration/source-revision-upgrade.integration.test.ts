import { PrismaClient, type Prisma } from "@prisma/client";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { HeuristicAnalysisProvider } from "@/lib/analysis/heuristic-provider";
import { buildDefaultEditorState, buildInitialEditorState, editorStateSchema } from "@/lib/editor/types";
import { createAnalyzeJobHandler } from "@/lib/jobs/handlers/analyze";
import { runTranscribeJob } from "@/lib/jobs/handlers/transcribe";
import { getStorageProvider } from "@/lib/storage";

const runFile = promisify(execFile);
const baseline = "20260905230000_agentic_editor_wave_2"; // Last migration in main 1d77d39.
const upgrade = "20260909150000_source_write_boundary";
// Only this generated identifier is interpolated into CREATE/DROP DATABASE. No existing name
// or caller-supplied identifier can enter either statement. CREATE does not use IF NOT EXISTS.
const databaseName = `source_upgrade_${randomUUID().replaceAll("-", "")}`;
let admin: PrismaClient | undefined;
let prisma: PrismaClient | undefined;
let createdDatabase = false;
let directory: string | undefined;
let workspaceId: string;
let userId: string;
type LegacyFixture = { sourceId: string; projectId: string; transcriptId: string; segmentId: string; clipId: string; jobId: string; reviewId: string | null };
let untouched: LegacyFixture;
let protectedFixture: LegacyFixture;
let oldSnapshots: Prisma.JsonValue[];

/** Refuse remote hosts and query-string routing overrides before constructing a DB client. */
function localUrl() {
  const configured = process.env.DATABASE_URL;
  if (!configured) throw new Error("The upgrade test requires an explicit localhost DATABASE_URL.");
  const url = new URL(configured);
  if (!["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname === "/" ||
      [...url.searchParams].some(([key, value]) => key !== "schema" || value !== "public")) {
    throw new Error("The upgrade test requires localhost Postgres with only schema=public; no routing overrides.");
  }
  return url;
}

async function migrate(url: URL) {
  // No generate, reset, seed, shell, or deployment wrapper. The same checked localhost URL
  // reaches the normal Prisma migrate-deploy command. It cannot use a repository .env URL.
  const result = await runFile(process.execPath, [
    path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", path.join(directory!, "schema.prisma"),
  ], { timeout: 60000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", env: {
    NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    DATABASE_URL: url.toString(), CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1",
  } });
  expect(result.stdout).toContain("All migrations have been successfully applied");
}

async function seedLegacy(edited: boolean): Promise<LegacyFixture> {
  // Parameterized SQL uses only old columns. The current generated client expects the new
  // revision fields, which do not exist at this point. No old client or worker is generated.
  const [source] = await prisma!.$queryRaw<{ id: string }[]>`
    INSERT INTO source_videos (workspace_id, origin, duration_s, srt_override_key, updated_at)
    VALUES (${workspaceId}::uuid, 'upload', 60, 'synthetic-upgrade.srt', CURRENT_TIMESTAMP) RETURNING id`;
  const [project] = await prisma!.$queryRaw<{ id: string }[]>`
    INSERT INTO projects (workspace_id, source_video_id, name, status, updated_at)
    VALUES (${workspaceId}::uuid, ${source.id}::uuid, 'Synthetic legacy service', 'ready', CURRENT_TIMESTAMP) RETURNING id`;
  const [transcript] = await prisma!.$queryRaw<{ id: string }[]>`
    INSERT INTO transcripts (source_video_id, language, provider, full_text, updated_at)
    VALUES (${source.id}::uuid, 'en', 'synthetic_legacy', 'Legacy caption words.', CURRENT_TIMESTAMP) RETURNING id`;
  const words = [
    { word: "Legacy", startMs: 0, endMs: 1000 },
    { word: "caption", startMs: 1000, endMs: 2000 },
    { word: "words.", startMs: 2000, endMs: 3000 },
  ];
  const [segment] = await prisma!.$queryRaw<{ id: string }[]>`
    INSERT INTO transcript_segments (transcript_id, idx, start_ms, end_ms, text, words, updated_at)
    VALUES (${transcript.id}::uuid, 0, 0, 60000, 'Legacy caption words.', ${JSON.stringify(words)}::jsonb, CURRENT_TIMESTAMP) RETURNING id`;
  const [clip] = await prisma!.$queryRaw<{ id: string }[]>`
    INSERT INTO generated_clips (workspace_id, project_id, rank, start_ms, end_ms, title, summary, updated_at)
    VALUES (${workspaceId}::uuid, ${project.id}::uuid, 1, 0, 60000, 'Legacy clip', 'Synthetic fixture', CURRENT_TIMESTAMP) RETURNING id`;
  // These pure editor builders are unchanged from main 1d77d39. Store valid legacy
  // documents, including a pinned word correction and a legacy caption case override.
  const params = { sourceVideoId: source.id, startMs: 0, endMs: 60000 };
  const editorState = edited ? buildDefaultEditorState(params) : buildInitialEditorState(params);
  if (edited) {
    editorState.version = 2;
    editorState.wordEdits.textOverrides = [{ wordId: `${segment.id}:0`, text: "Corrected" }];
    editorState.captions.overrides = { uppercase: true, box: { xPct: 0.1, yPct: 0.7 } };
  }
  editorStateSchema.parse(editorState);
  await prisma!.$executeRaw`
    INSERT INTO clip_edits (clip_id, version, editor_state, saved_by, updated_at)
    VALUES (${clip.id}::uuid, ${edited ? 2 : 1}, ${JSON.stringify(editorState)}::jsonb,
      ${edited ? userId : null}::uuid, CURRENT_TIMESTAMP)`;
  const [job] = await prisma!.$queryRaw<{ id: string }[]>`
    INSERT INTO processing_jobs (project_id, type, state, attempt, idempotency_key, finished_at, updated_at)
    VALUES (${project.id}::uuid, 'analyze', 'succeeded', 1, ${randomUUID()}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id`;
  let reviewId: string | null = null;
  if (edited) {
    const [review] = await prisma!.$queryRaw<{ id: string }[]>`
      INSERT INTO clip_reviews (workspace_id, decision, project_id_snapshot, scheduled_post_id_snapshot,
        clip_id_snapshot, clip_rank, clip_start_ms, clip_end_ms, export_job_id_snapshot, edit_version, checksum)
      VALUES (${workspaceId}::uuid, 'revise', ${project.id}::uuid, ${randomUUID()}::uuid,
        ${clip.id}::uuid, 1, 0, 60000, ${randomUUID()}::uuid, 2, 'synthetic-checksum') RETURNING id`;
    reviewId = review.id;
  }
  return { sourceId: source.id, projectId: project.id, transcriptId: transcript.id, segmentId: segment.id, clipId: clip.id, jobId: job.id, reviewId };
}

async function snapshot(fixture: LegacyFixture) {
  // Compare every legacy column, including times, generated search text, pinned editor JSON,
  // detached review snapshots, and terminal job history. Only the two new columns are omitted.
  const [row] = await prisma!.$queryRaw<{ value: Prisma.JsonValue }[]>`
    SELECT jsonb_build_object(
      'source', (SELECT to_jsonb(s) - 'transcript_revision' FROM source_videos s WHERE id = ${fixture.sourceId}::uuid),
      'project', (SELECT to_jsonb(p) FROM projects p WHERE id = ${fixture.projectId}::uuid),
      'transcript', (SELECT to_jsonb(t) FROM transcripts t WHERE id = ${fixture.transcriptId}::uuid),
      'segments', (SELECT jsonb_agg(to_jsonb(s) ORDER BY idx) FROM transcript_segments s WHERE transcript_id = ${fixture.transcriptId}::uuid),
      'clip', (SELECT to_jsonb(c) - 'transcript_revision' FROM generated_clips c WHERE id = ${fixture.clipId}::uuid),
      'edits', (SELECT jsonb_agg(to_jsonb(e) ORDER BY version) FROM clip_edits e WHERE clip_id = ${fixture.clipId}::uuid),
      'review', (SELECT to_jsonb(r) FROM clip_reviews r WHERE id = ${fixture.reviewId}::uuid),
      'job', (SELECT to_jsonb(j) FROM processing_jobs j WHERE id = ${fixture.jobId}::uuid)
    ) AS value`;
  return row.value;
}

beforeAll(async () => {
  const url = localUrl();
  admin = new PrismaClient({ datasourceUrl: url.toString() });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
  createdDatabase = true;
  url.pathname = `/${databaseName}`;
  prisma = new PrismaClient({ datasourceUrl: url.toString() });
  directory = await mkdtemp(path.join(os.tmpdir(), "source-upgrade-"));
  const migrations = path.join(directory, "migrations");
  await mkdir(migrations);
  // migrate deploy reads the migration chain, not a schema diff. Copying the current schema
  // supplies its datasource only and does not regenerate or change the repository client.
  await cp("prisma/schema.prisma", path.join(directory, "schema.prisma"));
  await cp("prisma/migrations/migration_lock.toml", path.join(migrations, "migration_lock.toml"));
  const names = (await readdir("prisma/migrations", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name <= baseline).map((entry) => entry.name).sort();
  expect(names).toHaveLength(26);
  expect(names.at(-1)).toBe(baseline);
  for (const name of names) await cp(path.join("prisma/migrations", name), path.join(migrations, name), { recursive: true });
  await migrate(url);
  expect(await prisma.$queryRaw`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'transcript_revision'`).toEqual([]);
  const [user] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO users (email, updated_at) VALUES (${`upgrade-${randomUUID()}@example.test`}, CURRENT_TIMESTAMP) RETURNING id`;
  userId = user.id;
  const [workspace] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO workspaces (name, owner_id, updated_at) VALUES ('Synthetic upgrade fixture', ${userId}::uuid, CURRENT_TIMESTAMP) RETURNING id`;
  workspaceId = workspace.id;
  untouched = await seedLegacy(false);
  protectedFixture = await seedLegacy(true);
  oldSnapshots = await Promise.all([snapshot(untouched), snapshot(protectedFixture)]);
  await cp(path.join("prisma/migrations", upgrade), path.join(migrations, upgrade), { recursive: true });
  await migrate(url);
}, 120000);

afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  try {
    await prisma?.$disconnect();
    if (createdDatabase) {
      // No FORCE, reset, or broad name match. An uncertain CREATE response is not ownership.
      await admin!.$executeRawUnsafe(`DROP DATABASE "${databaseName}"`);
      const remaining = await admin!.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM pg_database WHERE datname = ${databaseName}`;
      expect(remaining[0].count).toBe(BigInt(0));
    }
  } finally {
    await admin?.$disconnect();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

it("preserves populated legacy words, editor JSON, detached reviews, and completed jobs at baseline revision 0", async () => {
  expect(await Promise.all([snapshot(untouched), snapshot(protectedFixture)])).toEqual(oldSnapshots);
  expect(await prisma!.sourceVideo.findMany({ select: { transcriptRevision: true } }))
    .toEqual([{ transcriptRevision: 0 }, { transcriptRevision: 0 }]);
  expect(await prisma!.generatedClip.findMany({ select: { transcriptRevision: true } }))
    .toEqual([{ transcriptRevision: 0 }, { transcriptRevision: 0 }]);
  const migrations = await prisma!.$queryRaw<{ migration_name: string }[]>`
    SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`;
  expect(migrations).toHaveLength(27);
  expect(migrations.at(-1)?.migration_name).toBe(upgrade);
});

it("keeps old detached review decisions immutable after the upgrade", async () => {
  const before = await prisma!.clipReview.findUniqueOrThrow({ where: { id: protectedFixture.reviewId! } });
  await expect(prisma!.clipReview.update({ where: { id: before.id }, data: { decision: "ACCEPT" } }))
    .rejects.toThrow("append-only");
  await expect(prisma!.clipReview.update({ where: { id: before.id }, data: { checksum: "different-file" } }))
    .rejects.toThrow("append-only");
  expect(await prisma!.clipReview.findUnique({ where: { id: before.id } })).toEqual(before);
});

it("refuses replacement of upgraded human work before reading input, retaining its pinned word IDs", async () => {
  const before = await snapshot(protectedFixture);
  const read = vi.spyOn(getStorageProvider(), "readAsBuffer").mockRejectedValue(new Error("Must refuse before storage"));
  const job = await prisma!.processingJob.create({ data: {
    projectId: protectedFixture.projectId, type: "TRANSCRIBE", state: "RUNNING", attempt: 1, idempotencyKey: randomUUID(),
  } });
  await expect(runTranscribeJob({ job, prisma: prisma! })).rejects.toMatchObject({ code: "REANALYSIS_BLOCKED", preservesProject: true });
  expect(read).not.toHaveBeenCalled();
  expect(await snapshot(protectedFixture)).toEqual(before);
  expect(await prisma!.processingJob.count({ where: { projectId: protectedFixture.projectId, type: "ANALYZE", state: "QUEUED" } })).toBe(0);
});

it("rebuilds an upgraded untouched source with current workers and refuses revision-0 writes after advancement", async () => {
  const client = prisma!;
  const oldJob = await client.processingJob.findUniqueOrThrow({ where: { id: untouched.jobId } });
  vi.spyOn(getStorageProvider(), "readAsBuffer").mockResolvedValue(Buffer.from(
    "1\n00:00:00,000 --> 00:01:00,000\nGod gives joy through trials. His grace teaches us patience when the road is hard.\n",
  ));
  const job = await client.processingJob.create({ data: {
    projectId: untouched.projectId, type: "TRANSCRIBE", state: "RUNNING", attempt: 1, idempotencyKey: randomUUID(),
  } });
  await runTranscribeJob({ job, prisma: client });
  const source = await client.sourceVideo.findUniqueOrThrow({ where: { id: untouched.sourceId }, include: { transcript: true } });
  expect(source.transcriptRevision).toBe(1);
  expect(source.transcript!.id).not.toBe(untouched.transcriptId);
  await expect(client.clipEdit.create({ data: {
    clipId: untouched.clipId, version: 2, editorState: { wordId: `${untouched.segmentId}:0` },
  } })).rejects.toThrow("CLIP_TRANSCRIPT_CHANGED");
  // Old ANALYZE-style SQL omits the new column. This demonstrates its insert limit,
  // without running an old worker or pretending that old TRANSCRIBE increments revisions.
  await expect(client.$executeRaw`
    INSERT INTO generated_clips (workspace_id, project_id, rank, start_ms, end_ms, title, summary, updated_at)
    VALUES (${workspaceId}::uuid, ${untouched.projectId}::uuid, 2, 0, 60000, 'Old worker insert', 'Synthetic fixture', CURRENT_TIMESTAMP)`)
    .rejects.toThrow("CLIP_TRANSCRIPT_CHANGED");
  const analysis = await client.processingJob.findFirstOrThrow({ where: { projectId: untouched.projectId, type: "ANALYZE", state: "QUEUED" } });
  expect(analysis.idempotencyKey).toBe(`analyze:${untouched.projectId}:${job.id}:${source.transcript!.id}`);
  const handler = createAnalyzeJobHandler({ selectProvider: async () => ({
    provider: new HeuristicAnalysisProvider(), providerKind: "heuristic", selectionReason: "test_no_api_key", emergencyOverride: false,
  }) });
  await handler({ job: analysis, prisma: client });
  const clips = await client.generatedClip.findMany({ where: { projectId: untouched.projectId } });
  expect(clips.length).toBeGreaterThan(0);
  expect(clips.every((clip) => clip.transcriptRevision === 1)).toBe(true);
  expect(await client.generatedClip.findUnique({ where: { id: untouched.clipId } })).toBeNull();
  const initial = await client.clipEdit.findFirstOrThrow({ where: { clipId: clips[0].id } });
  expect(initial.editorState).toMatchObject({ systemInitial: true });
  const currentEdit = editorStateSchema.parse(initial.editorState);
  currentEdit.version = initial.version + 1;
  delete currentEdit.systemInitial;
  await client.clipEdit.create({ data: {
    clipId: clips[0].id, version: currentEdit.version, editorState: currentEdit as unknown as Prisma.InputJsonValue,
  } });
  expect(await client.processingJob.findUnique({ where: { id: oldJob.id } })).toEqual(oldJob);
});
