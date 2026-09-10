import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readPinnedTest } from "./release-rehearsal-files";
import { RehearsalPostgres } from "./rehearsal-postgres";
import { sha256 } from "./release-rehearsal";

/** Runs the pinned copy contract cases against the owned cluster and disk fixture adapter. */
export async function localStorageTests(pg: RehearsalPostgres, candidateBackup: { archive: string; sha256: string }, repo: string, candidateRoot: string) {
  const name = await pg.create(); await pg.restore(name, candidateBackup);
  const directory = path.join(candidateRoot, "rehearsal-tests"); mkdirSync(directory, { mode: 0o700 });
  const original = readPinnedTest(repo, "source-copy.integration.test.ts");
  const start = original.indexOf('  const url = new URL(process.env.DATABASE_URL ?? "");');
  const end = original.indexOf("  directory = await mkdtemp", start);
  if (start < 0 || end < 0) throw new Error("Pinned storage test guard did not match.");
  // Bind this test to one exact URL already created and owned by the runtime.
  const instrumented = original.slice(0, start) + `  if (process.env.DATABASE_URL !== ${JSON.stringify(pg.url(name))}) throw new Error("Wrong fixture database.");\n` + original.slice(end);
  const testFile = path.join(directory, "source-copy.test.ts");
  writeFileSync(testFile, instrumented, { flag: "wx", mode: 0o600 });
  const handoff = readPinnedTest(repo, "transcribe-handoff.integration.test.ts");
  writeFileSync(path.join(directory, "handoff.test.ts"), handoff, { flag: "wx", mode: 0o600 });
  const config = path.join(candidateRoot, "rehearsal-vitest.config.mjs");
  const configText = `export default {resolve:{alias:{'@prisma/client':${JSON.stringify(path.join(candidateRoot, "generated-client/index.js"))},'@':${JSON.stringify(path.join(candidateRoot, "src"))}}},test:{environment:'node',include:['rehearsal-tests/*.test.ts'],testTimeout:15000,hookTimeout:30000}};`;
  writeFileSync(config, configText, { flag: "wx", mode: 0o600 });
  const result = await pg.runtime.run(process.execPath, [path.join(repo, "node_modules/vitest/vitest.mjs"), "run", "--config", config], { DATABASE_URL: pg.url(name) }, 60000, candidateRoot);
  return { status: "PASS", originalSha256: sha256(original), instrumentedSha256: sha256(instrumented), handoffSha256: sha256(handoff), database: name, result,
    scope: "Pinned source-copy contract tests with disk fixture storage. No remote provider contract is proved." };
}
