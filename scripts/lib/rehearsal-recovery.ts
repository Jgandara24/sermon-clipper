import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REHEARSAL_REFS, sha256 } from "./release-rehearsal";
import { assertBuildSchema, until } from "./rehearsal-shutdown";
import { dataSnapshot } from "./rehearsal-fixtures";
import { RehearsalPostgres } from "./rehearsal-postgres";

export async function postWriteRecovery(pg: RehearsalPostgres, backup: { archive: string; sha256: string }, build: { worker: string; recover: string }) {
  const name = await pg.create(); await pg.restore(name, backup);
  const operationIds = [randomUUID(), randomUUID()];
  const objects = operationIds.map(id => path.join(pg.runtime.root, "storage", id));
  for (const file of objects) writeFileSync(file, "owned synthetic copy", { flag: "wx", mode: 0o600 });
  writeFileSync(path.join(pg.runtime.root, "owned-storage-objects.json"), JSON.stringify(objects.map(file => ({ file, hash: sha256("owned synthetic copy") }))), { flag: "wx", mode: 0o600 });
  await pg.sql(name, `UPDATE source_videos SET transcript_revision=1 WHERE id='00000000-0000-4000-8000-000000000101';
    INSERT INTO source_copy_operations(id,plan_hash,manifest,source_video_id,storage_key,state,retain_until) VALUES
    ('${operationIds[0]}','fixture','{}','${randomUUID()}','fixture/${operationIds[0]}','PREPARED',NOW()+INTERVAL '1 day'),
    ('${operationIds[1]}','fixture','{}','${randomUUID()}','fixture/${operationIds[1]}','COMPLETE',NOW()+INTERVAL '1 day')`);
  const before = await dataSnapshot(pg, name);
  const journal = async () => (await pg.sql(name, "SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM source_copy_operations j")).stdout.trim();
  const beforeJournal = await journal();
  let oldBuildRefused = false;
  try { await assertBuildSchema(pg, name, REHEARSAL_REFS.baseline); } catch { oldBuildRefused = true; }
  if (!oldBuildRefused) throw new Error("Old build was accepted after candidate writes.");
  let staleWriteRefused = false;
  try { await pg.sql(name, "UPDATE clip_edits SET editor_state=editor_state WHERE clip_id='00000000-0000-4000-8000-000000000105'"); }
  catch (error) { staleWriteRefused = String(error).includes("CLIP_TRANSCRIPT_CHANGED"); }
  if (!staleWriteRefused) throw new Error("Stale edit guard did not hold.");
  const jobId = randomUUID();
  await pg.sql(name, `INSERT INTO processing_jobs(id,project_id,type,state,idempotency_key,updated_at) VALUES ('${jobId}','00000000-0000-4000-8000-000000000102','transcribe','queued','${jobId}',NOW())`);
  const control = path.join(pg.runtime.root, `recovery-${jobId}`); mkdirSync(control, { mode: 0o700 });
  const environment = { DATABASE_URL: pg.url(name), WORKER_POLL_INTERVAL_MS: "100", REHEARSAL_CONTROL: control };
  await assertBuildSchema(pg, name, REHEARSAL_REFS.candidate);
  const child = pg.runtime.startExecutor(process.execPath, [build.worker], environment, path.dirname(build.worker));
  try {
    await until(() => existsSync(path.join(control, "claims.jsonl")));
    const result = await child.stop(10000);
    if (result.signal !== "SIGKILL") throw new Error("Blocked recovery fixture did not require forced stop.");
  } finally { if (!child.result) await child.stop(); }
  await pg.sql(name, `UPDATE processing_jobs SET heartbeat_at=NOW()-INTERVAL '1 day' WHERE id='${jobId}'`);
  const recovered = await pg.runtime.run(process.execPath, [build.recover], environment, 10000, path.dirname(build.recover));
  const state = (await pg.sql(name, `SELECT state FROM processing_jobs WHERE id='${jobId}'`)).stdout.trim();
  if (state !== "queued" && state !== "retrying") throw new Error("Actual queue recovery did not preserve retryable work.");
  // Advance only the owned retry's synthetic timer; preserve attempt/history fields.
  await pg.sql(name, `UPDATE processing_jobs SET run_after=NOW() WHERE id='${jobId}'`);
  writeFileSync(path.join(control, `release-${jobId}`), "synthetic release", { flag: "wx" });
  const restarted = pg.runtime.startExecutor(process.execPath, [build.worker], environment, path.dirname(build.worker));
  try {
    await until(async () => (await pg.sql(name, `SELECT state FROM processing_jobs WHERE id='${jobId}'`)).stdout.trim() === "succeeded");
  } finally { await restarted.stop(); }
  if (JSON.stringify(before) !== JSON.stringify(await dataSnapshot(pg, name)) || beforeJournal !== await journal()) throw new Error("Recovery changed durable fixture facts.");
  const hashes = objects.map(file => sha256(readFileSync(file)));
  if (hashes.some(hash => hash !== sha256("owned synthetic copy"))) throw new Error("Recovery changed stored fixture bytes.");
  return { status: "PASS", database: name, oldBuildRefused, staleWriteRefused, recovered, objectHashes: hashes, createdObjectPaths: objects,
    snapshotSha256: sha256(JSON.stringify(before)), journalSha256: sha256(beforeJournal),
    limit: "Candidate restart preserves post-migration facts. No alternative compatible rollback build was selected." };
}
