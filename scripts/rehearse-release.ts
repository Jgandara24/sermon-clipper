import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prepareRehearsal } from "./lib/release-rehearsal-files";
import { LocalRuntime, unusedPort } from "./lib/rehearsal-runtime";
import { RehearsalPostgres } from "./lib/rehearsal-postgres";
import { preparePinnedBuild } from "./lib/rehearsal-build";
import { dataSnapshot, schemaSnapshot, seedRehearsal } from "./lib/rehearsal-fixtures";
import { REHEARSAL_REFS, sha256 } from "./lib/release-rehearsal";
import { shutdownCase } from "./lib/rehearsal-shutdown";
import { migrationFailures } from "./lib/rehearsal-migrations";
import { localStorageTests } from "./lib/rehearsal-storage-tests";
import { postWriteRecovery } from "./lib/rehearsal-recovery";

async function main() {
  const args = process.argv.slice(2).join(" ");
  const migrationsOnly = args === "--local --case migrations";
  const contractsOnly = args === "--local --case contracts";
  if (args !== "--local" && !migrationsOnly && !contractsOnly) throw new Error("Use --local, optionally --case migrations or --case contracts, for synthetic rehearsal only.");
  const repo = process.cwd();
  const prepared = prepareRehearsal(repo);
  const root = realpathSync(prepared.root);
  console.log(`Owned rehearsal directory: ${root}`);
  const pgPort = await unusedPort();
  let webPort = await unusedPort();
  while (webPort === pgPort) webPort = await unusedPort();
  const runtime = new LocalRuntime(root, [pgPort, webPort]);
  const pg = new RehearsalPostgres(runtime, pgPort);
  const results: Record<string, unknown> = { root, startedAt: new Date().toISOString(), status: "RUNNING" };
  let ownedObjects: { file: string; hash: string }[] = [];
  const save = () => writeFileSync(path.join(root, "local-results.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
  save();
  try {
    results.network = await runtime.verifyNetwork();
    await pg.start();
    const baseline = await pg.create();
    results.database = { name: baseline, port: pgPort, data: pg.data };
    const baselineRoot = path.join(root, "baseline"), candidateRoot = path.join(root, "candidate");
    if (migrationsOnly) {
      const cli = path.join(repo, "node_modules/prisma/build/index.js");
      await pg.migrate(baseline, cli, path.join(baselineRoot, "prisma/schema.prisma"));
      await seedRehearsal(pg, baseline);
      writeFileSync(path.join(candidateRoot, "prisma/rehearsal.prisma"), readFileSync(path.join(candidateRoot, "prisma/schema.prisma")), { flag: "wx" });
      results.migrationFailures = await migrationFailures(pg, await pg.dump(baseline), repo, candidateRoot);
      results.status = "PASS — migration cases only";
      return;
    }
    if (contractsOnly) {
      const candidateBuild = await preparePinnedBuild(repo, candidateRoot, runtime, pg.url(baseline));
      const cli = path.join(repo, "node_modules/prisma/build/index.js");
      await pg.migrate(baseline, cli, path.join(candidateRoot, "prisma/rehearsal.prisma"));
      await seedRehearsal(pg, baseline);
      const backup = await pg.dump(baseline);
      results.localStorage = await localStorageTests(pg, backup, repo, candidateRoot); save();
      results.postWriteRecovery = await postWriteRecovery(pg, backup, candidateBuild);
      results.status = "PASS — contract and recovery cases only";
      return;
    }
    const baselineBuild = await preparePinnedBuild(repo, baselineRoot, runtime, pg.url(baseline));
    const candidateBuild = await preparePinnedBuild(repo, candidateRoot, runtime, pg.url(baseline));
    results.builds = { baseline: baselineBuild.record, candidate: candidateBuild.record }; save();
    const migrate = async (buildRoot: string, name: string) => pg.migrate(name, path.join(repo, "node_modules/prisma/build/index.js"), path.join(buildRoot, "prisma/rehearsal.prisma"));
    results.baselineMigration = await migrate(baselineRoot, baseline);
    await seedRehearsal(pg, baseline);
    const before = await dataSnapshot(pg, baseline);
    const schemaBefore = await schemaSnapshot(pg, baseline);
    results.baselineSnapshot = before;
    const backup = await pg.dump(baseline);
    const restored = await pg.create("restore");
    await pg.restore(restored, backup);
    const after = await dataSnapshot(pg, restored);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Restored fixture data differs.");
    if (JSON.stringify(schemaBefore) !== JSON.stringify(await schemaSnapshot(pg, restored))) throw new Error("Restored schema, counts or migration history differs.");
    results.restore = { status: "PASS", backup, snapshotSha256: sha256(JSON.stringify(before)), schemaBefore,
      sequenceLimit: schemaBefore.sequences.length === 0 ? "No public sequences exist in this UUID-based schema." : "Sequence values compared; allocation still needs verification." };
    let overwriteRefused = false;
    try { await pg.restore(restored, backup); } catch { overwriteRefused = true; }
    if (!overwriteRefused) throw new Error("Populated restore target was accepted.");
    const corrupt = path.join(root, "corrupt.dump");
    writeFileSync(corrupt, readFileSync(backup.archive).subarray(0, 24));
    const corruptTarget = await pg.create("restore");
    let corruptionRefused = false;
    try { await pg.restore(corruptTarget, { archive: corrupt, sha256: sha256(readFileSync(corrupt)) }); } catch { corruptionRefused = true; }
    if (!corruptionRefused) throw new Error("Corrupted archive was accepted.");
    results.restoreRefusals = { overwriteRefused, corruptionRefused };
    const shutdownResults: unknown[] = [];
    results.shutdown = shutdownResults;
    for (const role of ["worker", "web"] as const) for (const mode of ["idle", "release", "forced"] as const) {
      console.log(`Baseline ${role}: ${mode}`);
      shutdownResults.push(await shutdownCase(pg, backup, baselineBuild, REHEARSAL_REFS.baseline, webPort, role, mode)); save();
    }
    results.migrationFailures = await migrationFailures(pg, backup, repo, candidateRoot); save();
    results.candidateMigration = await migrate(candidateRoot, baseline);
    results.migrationCount = (await pg.sql(baseline, "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")).stdout.trim();
    if (results.migrationCount !== "28") throw new Error("Candidate migration chain is incomplete.");
    const migratedSnapshot = await dataSnapshot(pg, baseline);
    for (const table of ["source_videos", "generated_clips"]) for (const row of migratedSnapshot[table] as Record<string, unknown>[]) {
      if (row.transcript_revision !== 0) throw new Error("Unexpected baseline transcript revision.");
      delete row.transcript_revision; // The two explicitly added fields are checked above.
    }
    if (JSON.stringify(before) !== JSON.stringify(migratedSnapshot)) throw new Error("Migration changed legacy fixture data.");
    results.legacyDataPreserved = true;
    const candidateBackup = await pg.dump(baseline);
    for (const role of ["worker", "web"] as const) for (const mode of ["idle", "release", "forced"] as const) {
      console.log(`Candidate ${role}: ${mode}`);
      shutdownResults.push(await shutdownCase(pg, candidateBackup, candidateBuild, REHEARSAL_REFS.candidate, webPort, role, mode)); save();
    }
    results.preWriteRollback = [];
    for (const role of ["worker", "web"] as const) {
      (results.preWriteRollback as unknown[]).push(await shutdownCase(pg, backup, baselineBuild, REHEARSAL_REFS.baseline, webPort, role, "idle"));
    }
    results.localStorage = await localStorageTests(pg, candidateBackup, repo, candidateRoot); save();
    const recovery = await postWriteRecovery(pg, candidateBackup, candidateBuild);
    results.postWriteRecovery = recovery;
    ownedObjects = recovery.createdObjectPaths.map((file, index) => ({ file, hash: recovery.objectHashes[index] })); save();
    results.remaining = ["remote storage contracts"];
    results.status = "LOCAL PASS — remote storage BLOCKED";
  } catch (error) {
    results.status = "FAIL";
    results.error = error instanceof Error ? error.stack : "Unknown fixture failure";
    process.exitCode = 1;
  } finally {
    try { await pg.cleanup(); results.databaseCleanup = "PASS"; }
    catch (error) { results.databaseCleanup = String(error); process.exitCode = 1; }
    try { await runtime.stopAll(); results.processCleanup = "PASS"; }
    catch (error) { results.processCleanup = String(error); results.status = "FAIL"; process.exitCode = 1; }
    if (results.databaseCleanup === "PASS") {
      try {
        const ownershipFile = path.join(root, "owned-storage-objects.json");
        if (existsSync(ownershipFile)) ownedObjects = JSON.parse(readFileSync(ownershipFile, "utf8"));
        for (const object of ownedObjects) {
          if (path.dirname(object.file) !== path.join(root, "storage") || sha256(readFileSync(object.file)) !== object.hash) throw new Error("Owned object cleanup identity differs.");
          unlinkSync(object.file);
        }
        results.ownedObjectCleanup = { removed: ownedObjects.length, prerequisite: "All owned databases dropped and the owned cluster stopped." };
      } catch (error) {
        results.ownedObjectCleanup = { status: "BLOCKED", error: String(error) };
        results.status = "FAIL"; process.exitCode = 1;
      }
    }
    results.finishedAt = new Date().toISOString(); save();
    console.log(`Local rehearsal status: ${results.status}. Evidence: ${path.join(root, "local-results.json")}`);
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Rehearsal failed"); process.exitCode = 1; });
