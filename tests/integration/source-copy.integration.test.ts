import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { applySourceCopy, planSourceCopy, copyPlanHash, type CopyStorage, type CopyInput } from "@/lib/operations/source-copy";

const prisma = new PrismaClient();
const workspaceIds: string[] = [], operationIds: string[] = [];
let operatorId: string, importerId: string, directory: string;
const now = new Date("2026-09-10T03:00:00Z");
const options = { now, runtime: { AUTOMATIC_PUBLISHING_ENABLED: "false", AUTOMATIC_SCHEDULE_ARMING_ENABLED: "false" } };
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const ciDatabase = process.env.GITHUB_ACTIONS === "true" && url.pathname === "/sermon_clipper";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !(url.pathname.includes("test") || url.pathname.includes("p2_day") || ciDatabase)) {
    throw new Error("Use a disposable local test database.");
  }
  directory = await mkdtemp(path.join(os.tmpdir(), "source-copy-test-"));
  operatorId = (await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, isPlatformOperator: true } })).id;
  importerId = (await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } })).id;
});
afterAll(async () => {
  await prisma.sourceCopyOperation.deleteMany({ where: { id: { in: operationIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [operatorId, importerId].filter(Boolean) } } });
  await prisma.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const sourceWorkspace = await prisma.workspace.create({ data: { ownerId: operatorId, name: "Source fixture",
    members: { create: { userId: operatorId, role: "OWNER" } } } });
  const target = await prisma.workspace.create({ data: { ownerId: importerId, name: "Sandbox fixture", accessPlan: "PAID",
    members: { create: { userId: importerId, role: "OWNER" } } } });
  workspaceIds.push(sourceWorkspace.id, target.id);
  const source = await prisma.sourceVideo.create({ data: { workspaceId: sourceWorkspace.id, origin: "UPLOAD",
    storageKey: `source-${randomUUID()}`, durationS: 2981.76, language: "en" } });
  const project = await prisma.project.create({ data: { workspaceId: sourceWorkspace.id, sourceVideoId: source.id,
    name: "Old fixture", status: "READY", sermonDate: new Date("2026-08-11") } });
  const files = new Map<string, { file: string; owner: string | null }>();
  const sourceFile = path.join(directory, randomUUID());
  await writeFile(sourceFile, Buffer.from("Disposable source bytes; never production media."));
  files.set(source.storageKey!, { file: sourceFile, owner: null });
  let copies = 0, failAfterCopy = false, corruptCopy = false, beforeReturn: (() => Promise<void>) | undefined;
  const storage: CopyStorage = {
    identity: `local-fixture-${randomUUID()}`,
    async inspect(key, maxBytes) {
      const item = files.get(key); if (!item) return null;
      const b = await readFile(item.file); if (b.length > maxBytes) throw new Error("too large");
      const sha256 = createHash("sha256").update(b).digest("hex");
      return { bytes: b.length, sha256, etag: sha256, owner: item.owner, versionId: null, lastModified: null };
    },
    async copy(src, dest, etag, owner) {
      if (files.has(dest)) throw new Error("destination exists");
      const item = await storage.inspect(src, 1000); if (!item || item.etag !== etag) throw new Error("source changed");
      const file = path.join(directory, randomUUID());
      await writeFile(file, corruptCopy ? Buffer.from("bad") : await readFile(files.get(src)!.file), { flag: "wx" });
      files.set(dest, { file, owner }); copies++;
      if (beforeReturn) await beforeReturn();
      if (failAfterCopy) { failAfterCopy = false; throw new Error("uncertain copy response"); }
    },
  };
  const input: CopyInput = { operatorId, importUserId: importerId, workspaceId: target.id, projectId: project.id,
    sermonDate: "2026-05-20", occurrence: "UNMATCHED", maxBytes: 1000 };
  async function plan() { const result = await planSourceCopy(prisma, storage, input, options); operationIds.push(result.plan.operationId); return result; }
  return { source, sourceFile, project, target, sourceWorkspace, files, storage, input, plan,
    copies: () => copies, failCopy: () => { failAfterCopy = true; }, corrupt: () => { corruptCopy = true; },
    onCopy: (callback: () => Promise<void>) => { beforeReturn = callback; } };
}
async function apply(f: Awaited<ReturnType<typeof fixture>>, p: Awaited<ReturnType<typeof planSourceCopy>>) {
  return applySourceCopy(prisma, f.storage, p.plan, p.confirmation, f.target.id, options);
}
async function counts(workspaceId: string) {
  return { sources: await prisma.sourceVideo.count({ where: { workspaceId } }),
    projects: await prisma.project.count({ where: { workspaceId } }), jobs: await prisma.processingJob.count({ where: { project: { workspaceId } } }),
    exports: await prisma.exportJob.count({ where: { workspaceId } }), transcripts: await prisma.transcript.count({ where: { sourceVideo: { workspaceId } } }) };
}
describe("separate source copy with disposable disk and database fixtures", () => {
  it("waits for a project-first writer without holding its source lock", async () => {
    const f = await fixture(), p = await f.plan();
    let projectLocked!: (pid: number) => void, continueWriter!: () => void;
    const locked = new Promise<number>(resolve => { projectLocked = resolve; });
    const proceed = new Promise<void>(resolve => { continueWriter = resolve; });
    const writer = prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM projects WHERE id = ${f.project.id}::uuid FOR NO KEY UPDATE`;
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      projectLocked(backend.pid);
      await proceed;
      // A source-first copy would hold this row while waiting for our project.
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1500ms'");
      await tx.$queryRaw`SELECT id FROM source_videos WHERE id = ${f.source.id}::uuid FOR UPDATE`;
      return "writer completed";
    }, { timeout: 10000 });
    let copy: ReturnType<typeof apply> | undefined;
    try {
      const pid = await locked;
      copy = apply(f, p);
      // Observe an actual lock wait, rather than use a delay to guess the race.
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (!waiting && Date.now() < deadline) {
        const [observed] = await prisma.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
              AND query LIKE '%FROM projects%') AS waiting`;
        waiting = observed.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      continueWriter();
      const results = await Promise.allSettled([writer, copy]);
      expect(results[0]).toEqual({ status: "fulfilled", value: "writer completed" });
      expect(results[1].status).toBe("fulfilled");
      expect(f.copies()).toBe(1);
      expect(await counts(f.target.id)).toMatchObject({ sources: 1, projects: 0, jobs: 0 });
    } finally {
      continueWriter();
      await Promise.allSettled([writer, ...(copy ? [copy] : [])]);
    }
  }, 15000);
  it.each(["versionId", "lastModified"] as const)("refuses identical bytes with changed %s", async field => {
    const f = await fixture(), p = await f.plan();
    const inspect = f.storage.inspect.bind(f.storage);
    f.storage.inspect = async (key, max) => {
      const object = await inspect(key, max);
      return object && key === f.source.storageKey ? { ...object,
        [field]: field === "versionId" ? "new-version" : "2026-09-10T03:01:00.000Z" } : object;
    };
    await expect(apply(f, p)).rejects.toThrow("SOURCE_CHANGED");
    expect(f.copies()).toBe(0);
  });
  it.each(["source", "trial", "plan"])("refuses registration when %s expires during copy", async expiry => {
    const f = await fixture();
    if (expiry === "source") await prisma.project.update({ where: { id: f.project.id },
      data: { expiresAt: new Date(now.valueOf() + 1000) } });
    if (expiry === "trial") await prisma.workspace.update({ where: { id: f.target.id },
      data: { accessPlan: "TRIAL", paidAt: null, trialEndsAt: new Date(now.valueOf() + 1000) } });
    const p = await f.plan();
    let clock = now;
    f.onCopy(async () => { clock = new Date(now.valueOf() + (expiry === "plan" ? 31 * 60_000 : 2000)); });
    await expect(applySourceCopy(prisma, f.storage, p.plan, p.confirmation, f.target.id,
      { ...options, clock: () => clock })).rejects.toThrow();
    expect((await counts(f.target.id)).sources).toBe(0);
    expect(f.copies()).toBe(1);
    expect(await prisma.sourceCopyOperation.findUnique({ where: { id: p.plan.operationId } })).toMatchObject({ state: "PREPARED" });
  });
  it("plans without writes, copies once, preserves old date, and creates no service or processing", async () => {
    const f = await fixture(), before = await counts(f.target.id);
    const p = await f.plan();
    expect(await counts(f.target.id)).toEqual(before);
    expect(await prisma.sourceCopyOperation.findUnique({ where: { id: p.plan.operationId } })).toBeNull();
    expect(f.files.size).toBe(1);
    expect(p.plan.facts.oldDate).toBe("2026-08-11");
    const result = await apply(f, p);
    expect(result).toMatchObject({ applied: true, reused: false, jobsCreated: 0, sermonDate: "2026-05-20" });
    expect(await counts(f.target.id)).toEqual({ ...before, sources: 1 });
    expect(await prisma.project.findUnique({ where: { id: f.project.id } })).toMatchObject({ sermonDate: new Date("2026-08-11") });
    expect(await apply(f, p)).toMatchObject({ reused: true });
    expect(f.copies()).toBe(1);
    expect(await readFile(f.sourceFile, "utf8")).toContain("Disposable source bytes");
  });
  it("recovers after copy succeeds but response is lost", async () => {
    const f = await fixture(), p = await f.plan(); f.failCopy();
    await expect(apply(f, p)).rejects.toThrow("uncertain");
    expect(await prisma.sourceCopyOperation.findUnique({ where: { id: p.plan.operationId } })).toMatchObject({ state: "PREPARED" });
    expect((await counts(f.target.id)).sources).toBe(0);
    await expect(apply(f, p)).resolves.toMatchObject({ applied: true });
    expect(f.copies()).toBe(1);
  });
  it("refuses wrong confirmation, target, and edited manifest before writes", async () => {
    const f = await fixture(), p = await f.plan();
    await expect(applySourceCopy(prisma, f.storage, p.plan, "bad", f.target.id, options)).rejects.toThrow("CONFIRMATION");
    await expect(applySourceCopy(prisma, f.storage, p.plan, p.confirmation, randomUUID(), options)).rejects.toThrow("CONFIRMATION");
    p.plan.input.sermonDate = "2026-05-21";
    await expect(apply(f, p)).rejects.toThrow("CONFIRMATION");
    expect(await prisma.sourceCopyOperation.findUnique({ where: { id: p.plan.operationId } })).toBeNull();
  });
  it("refuses expired plans and unsafe automation", async () => {
    const f = await fixture(), p = await f.plan();
    await expect(applySourceCopy(prisma, f.storage, p.plan, p.confirmation, f.target.id,
      { ...options, now: new Date(now.valueOf() + 31 * 60_000) })).rejects.toThrow("PLAN_EXPIRED");
    await expect(planSourceCopy(prisma, f.storage, f.input,
      { ...options, runtime: { AUTOMATIC_PUBLISHING_ENABLED: "true" } })).rejects.toThrow("AUTOMATION");
  });
  it("refuses missing target permission and source membership", async () => {
    const f = await fixture();
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: f.target.id, userId: importerId } } });
    await expect(f.plan()).rejects.toThrow("TARGET_ACCESS");
    const other = await fixture();
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: other.sourceWorkspace.id, userId: operatorId } } });
    await expect(other.plan()).rejects.toThrow("SOURCE_ACCESS");
  });
  it("refuses low minute balance and non-operator identity", async () => {
    const f = await fixture();
    await prisma.workspace.update({ where: { id: f.target.id }, data: { minuteBalance: 1 } });
    await expect(f.plan()).rejects.toThrow("MINUTES");
    await expect(planSourceCopy(prisma, f.storage, { ...f.input, operatorId: importerId }, options)).rejects.toThrow("platform operator");
  });
  it("refuses changed access after plan", async () => {
    const f = await fixture(), p = await f.plan();
    await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: f.target.id, userId: importerId } }, data: { status: "INVITED" } });
    await expect(apply(f, p)).rejects.toThrow("TARGET_ACCESS");
    expect(f.copies()).toBe(0);
  });
  it("refuses source bytes changed after plan", async () => {
    const f = await fixture(), p = await f.plan();
    await writeFile(f.sourceFile, "changed source");
    await expect(apply(f, p)).rejects.toThrow("SOURCE_CHANGED");
    expect(f.copies()).toBe(0);
  });
  it("refuses an existing foreign destination without overwrite or deletion", async () => {
    const f = await fixture(), p = await f.plan();
    f.files.set(p.plan.destinationKey, { file: f.sourceFile, owner: "someone-else" });
    await expect(apply(f, p)).rejects.toThrow("COPY_VERIFICATION_FAILED");
    expect(f.copies()).toBe(0);
    expect(f.files.size).toBe(2);
  });
  it("keeps a failed checksum copy for private recovery; registers nothing", async () => {
    const f = await fixture(), p = await f.plan(); f.corrupt();
    await expect(apply(f, p)).rejects.toThrow("COPY_VERIFICATION_FAILED");
    expect((await counts(f.target.id)).sources).toBe(0);
    expect(f.files.size).toBe(2);
  });
  it("refuses a conflicting operation manifest", async () => {
    const f = await fixture(), p = await f.plan(); f.failCopy();
    await expect(apply(f, p)).rejects.toThrow();
    p.plan.input.occurrence = "PRIMARY"; p.confirmation = copyPlanHash(p.plan);
    await expect(apply(f, p)).rejects.toThrow("OPERATION_CONFLICT");
    expect(f.copies()).toBe(1);
  });
  it("does not recreate a completed object that is missing", async () => {
    const f = await fixture(), p = await f.plan(); await apply(f, p);
    f.files.delete(p.plan.destinationKey);
    await expect(apply(f, p)).rejects.toThrow("REGISTERED_OBJECT_MISSING");
    expect(f.copies()).toBe(1);
  });
  it("recovers from a database registration conflict without repeating the copy", async () => {
    const f = await fixture(), p = await f.plan();
    f.onCopy(async () => {
      await prisma.sourceVideo.create({ data: { id: p.plan.destinationId, workspaceId: f.target.id,
        origin: "UPLOAD", storageKey: "foreign-fixture-key" } });
    });
    await expect(apply(f, p)).rejects.toThrow();
    expect(f.copies()).toBe(1);
    expect(await prisma.sourceCopyOperation.findUnique({ where: { id: p.plan.operationId } })).toMatchObject({ state: "PREPARED" });
    // Test-only disposal of our conflicting row. The command must never remove it.
    expect(await prisma.sourceVideo.findUnique({ where: { id: p.plan.destinationId } })).toMatchObject({ storageKey: "foreign-fixture-key" });
    await prisma.sourceVideo.delete({ where: { id: p.plan.destinationId } });
    await expect(apply(f, p)).resolves.toMatchObject({ applied: true });
    expect(f.copies()).toBe(1);
  });
  it("serializes concurrent applies and never copies twice", async () => {
    const f = await fixture(), p = await f.plan();
    const results = await Promise.allSettled([apply(f, p), apply(f, p)]);
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
    // PostgreSQL can reject a waiting serializable transaction. A normal retry is safe.
    await expect(apply(f, p)).resolves.toMatchObject({ reused: true });
    expect(f.copies()).toBe(1);
    expect(await counts(f.target.id)).toMatchObject({ sources: 1, projects: 0, jobs: 0 });
  });
});
