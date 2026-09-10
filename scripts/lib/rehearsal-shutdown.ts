import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { RehearsalPostgres } from "./rehearsal-postgres";
import { type OwnedProcess } from "./rehearsal-runtime";
import { REHEARSAL_REFS } from "./release-rehearsal";

export async function until(test: () => boolean | Promise<boolean>, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Fixture observation deadline exceeded.");
}

export async function assertBuildSchema(pg: RehearsalPostgres, database: string, commit: string) {
  const count = (await pg.sql(database, "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")).stdout.trim();
  const expected = commit === REHEARSAL_REFS.baseline ? "26" : commit === REHEARSAL_REFS.candidate ? "28" : null;
  if (!expected || count !== expected) throw new Error("Pinned build is incompatible with this fixture schema.");
}

/** No background restart. Closing this controller makes every later start fail. */
export class ExecutorController {
  private closed = false;
  readonly processes: OwnedProcess[] = [];
  start(launch: () => OwnedProcess) {
    if (this.closed) throw new Error("Executor restart is disabled.");
    const child = launch(); this.processes.push(child); return child;
  }
  close() { this.closed = true; }
  assertStopped() {
    if (!this.closed || !this.processes.length || this.processes.some(child => !child.result || child.groupAlive())) throw new Error("Executors remain active.");
  }
}

export async function shutdownCase(pg: RehearsalPostgres, backup: { archive: string; sha256: string }, build: { worker: string; web: string; nativeWeb?: string },
  commit: string, webPort: number, role: "worker" | "web", mode: "idle" | "release" | "forced") {
  const database = await pg.create("restore");
  await pg.restore(database, backup);
  await assertBuildSchema(pg, database, commit);
  const control = path.join(pg.runtime.root, `control-${randomUUID()}`); mkdirSync(control, { mode: 0o700 });
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  if (mode !== "idle") {
    await pg.sql(database, `INSERT INTO processing_jobs(id,project_id,type,state,attempt,idempotency_key,created_at,run_after,updated_at) VALUES
      ('${ids[0]}','00000000-0000-4000-8000-000000000102','transcribe','queued',0,'${ids[0]}',NOW()-INTERVAL '3 seconds',NOW(),NOW()),
      ('${ids[1]}','00000000-0000-4000-8000-000000000102','transcribe','queued',0,'${ids[1]}',NOW()-INTERVAL '2 seconds',NOW(),NOW()),
      ('${ids[2]}','00000000-0000-4000-8000-000000000102','transcribe','retrying',1,'${ids[2]}',NOW()-INTERVAL '1 second',NOW()+INTERVAL '1 day',NOW())`);
    writeFileSync(path.join(control, `release-${ids[1]}`), "synthetic release", { flag: "wx" });
  }
  const controller = new ExecutorController();
  const native = role === "web" && build.nativeWeb;
  const launch = () => pg.runtime.startExecutor(process.execPath, native ? [path.join(native, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(webPort)] : [build[role]], {
    DATABASE_URL: pg.url(database), WORKER_POLL_INTERVAL_MS: "100", REHEARSAL_CONTROL: control,
    REHEARSAL_PORT: String(webPort), SERMON_CLIPPER_COMMIT_SHA: commit,
  }, native || path.dirname(build[role]));
  const child = controller.start(launch);
  const claimsPath = path.join(control, "claims.jsonl");
  const claims = () => existsSync(claimsPath) ? readFileSync(claimsPath, "utf8") : "";
  const base = `http://127.0.0.1:${webPort}`;
  try {
    await until(() => {
      if (child.result) throw new Error(`Fixture executor exited during startup: ${child.output().stderr}`);
      return child.output().stdout.includes(role === "web" ? native ? "Ready in" : "fixture web ready" : "polling for processing jobs");
    });
    if (role === "web") {
      const health = await (await fetch(base + "/health")).json();
      if (health.commit !== commit) throw new Error("Fixture build identity differs.");
      if (mode !== "idle" && (await fetch(base + "/fixture")).status !== 200) throw new Error("Fixture intake failed.");
    }
    if (mode !== "idle") await until(() => claims().includes(ids[0]));
    controller.close();
    let restartRefused = false, migrationRefused = false;
    try { controller.start(launch); } catch { restartRefused = true; }
    try {
      const buildRoot = path.dirname(path.dirname(build.worker));
      await pg.migrate(database, path.join(buildRoot, "node_modules/prisma/build/index.js"), path.join(buildRoot, "prisma/rehearsal.prisma"));
    } catch (error) { migrationRefused = String(error).includes("Executors remain active"); }
    if (!restartRefused || !migrationRefused) throw new Error("Executor safety gate failed.");
    if (role === "web") {
      await fetch(base + "/close");
      if ((await fetch(base + "/fixture")).status !== 409) throw new Error("Closed intake accepted work.");
    }
    const signalAt = Date.now();
    child.signal("SIGTERM");
    if (mode === "release") writeFileSync(path.join(control, `release-${ids[0]}`), "synthetic release", { flag: "wx" });
    let forced = false;
    try { await child.wait(mode === "forced" ? 10000 : 12000); }
    catch { forced = true; child.signal("SIGKILL"); await child.wait(5000); }
    if ((mode === "forced") !== forced) throw new Error("Executor shutdown outcome differs.");
    controller.assertStopped();
    const afterExit = claims();
    await new Promise(resolve => setTimeout(resolve, 250)); // More than two 100ms polls.
    controller.assertStopped();
    if (claims() !== afterExit) throw new Error("Claim activity continued after exit.");
    const rows = JSON.parse((await pg.sql(database, "SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY created_at),'[]') FROM processing_jobs j")).stdout);
    if (mode !== "idle") {
      const first = rows.find((row: { id: string }) => row.id === ids[0]);
      const successor = rows.find((row: { id: string }) => row.id === ids[1]);
      const retry = rows.find((row: { id: string }) => row.id === ids[2]);
      if (first.state !== (mode === "forced" ? "running" : "succeeded") || retry.state !== "retrying") throw new Error("Unexpected final fixture job state.");
      if (successor.state !== (role === "web" && mode === "release" ? "succeeded" : "queued")) throw new Error("Unexpected successor state.");
    }
    return { role, mode, nativeNext: Boolean(native), commit, database, pid: child.child.pid, parentPid: child.parentPid, startedAt: child.startedAt,
      signalAt, result: child.result, forced, restartRefused, migrationRefused, claims: afterExit, rows, quietMs: 250, status: "PASS" };
  } finally {
    if (!child.result) await child.stop();
    writeFileSync(path.join(control, "process-result.json"), JSON.stringify({ role, mode, pid: child.child.pid, result: child.result }, null, 2), { mode: 0o600 });
  }
}
