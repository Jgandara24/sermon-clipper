import { cpSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { RehearsalPostgres } from "./rehearsal-postgres";

export async function migrationFailures(pg: RehearsalPostgres, baselineBackup: { archive: string; sha256: string }, repo: string, candidateRoot: string) {
  const prisma = path.join(repo, "node_modules/prisma/build/index.js");
  const migrate = (name: string, schema: string) => pg.migrate(name, prisma, schema);
  const candidateSchema = path.join(candidateRoot, "prisma/rehearsal.prisma");
  const name = await pg.create(); await pg.restore(name, baselineBackup);
  await pg.sql(name, `ALTER DATABASE "${name}" SET lock_timeout = '250ms'`);
  const lock = pg.startSql(name, "BEGIN; LOCK TABLE source_videos IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(60); COMMIT;");
  let failedMessage = "";
  let backendPid: number | undefined;
  try {
    let acquired = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const count = await pg.sql(name, "SELECT pid FROM pg_locks WHERE relation='source_videos'::regclass AND mode='AccessExclusiveLock' AND granted");
      if (/^\d+$/.test(count.stdout.trim())) { backendPid = Number(count.stdout.trim()); acquired = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!acquired) throw new Error("Fixture lock was not acquired.");
    try { await migrate(name, candidateSchema); } catch (error) { failedMessage = String(error); }
    if (!failedMessage.includes("lock timeout")) throw new Error("Migration did not fail on the controlled lock timeout.");
  } finally {
    if (backendPid) await pg.sql(name, `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid=${backendPid} AND datname='${name}'`);
    await lock.stop(200);
  }
  const columns = await pg.sql(name, "SELECT count(*) FROM information_schema.columns WHERE table_name='source_videos' AND column_name='transcript_revision'");
  if (columns.stdout.trim() !== "0") throw new Error("Failed migration changed its first schema target.");
  const failure = await pg.sql(name, "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL");
  if (failure.stdout.trim() !== "20260909150000_source_write_boundary") throw new Error("Unexpected failed migration history.");
  await pg.sql(name, `ALTER DATABASE "${name}" RESET lock_timeout`);
  const resolve = await pg.migrate(name, prisma, candidateSchema, "20260909150000_source_write_boundary");
  await migrate(name, candidateSchema);
  const finalCount = (await pg.sql(name, "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")).stdout.trim();
  if (finalCount !== "28") throw new Error("Lock recovery did not complete the chain.");

  const partial = await pg.create(); await pg.restore(partial, baselineBackup);
  const partialRoot = path.join(pg.runtime.root, "partial-migration"); mkdirSync(partialRoot, { mode: 0o700 });
  cpSync(candidateSchema, path.join(partialRoot, "schema.prisma"));
  mkdirSync(path.join(partialRoot, "migrations"));
  for (const entry of readdirSync(path.join(candidateRoot, "prisma/migrations"))) {
    if (entry === "20260910030000_source_copy_operations") continue;
    cpSync(path.join(candidateRoot, "prisma/migrations", entry), path.join(partialRoot, "migrations", entry), { recursive: true });
  }
  await migrate(partial, path.join(partialRoot, "schema.prisma"));
  const partialCount = (await pg.sql(partial, "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")).stdout.trim();
  if (partialCount !== "27") throw new Error("Expected exactly one candidate migration at the interruption boundary.");
  await migrate(partial, candidateSchema);
  const resumedCount = (await pg.sql(partial, "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL")).stdout.trim();
  if (resumedCount !== "28") throw new Error("Interrupted chain did not resume.");
  return { lockTimeout: { status: "PASS", database: name, failedMessage, firstTargetUnchanged: true, resolve: resolve.stdout, finalCount },
    interruption: { status: "PASS", database: partial, partialCount, resumedCount, boundary: "Controlled stop between migrations; not a mid-statement process kill" } };
}
