import { parseArgs } from "node:util";
import { applyFixtureCleanup, createCleanupFixture, FixtureStore, manifestHash, type Fault } from "./lib/six-file-cleanup";

const usage = `Local disposable fixture only:
  npx tsx scripts/cleanup-six-files.ts --fixture
  npx tsx scripts/cleanup-six-files.ts --fixture --interrupt after-delete
Creates six synthetic objects, verified local backups, and a local record file.
Runs cleanup, then verifies replay. An interruption resumes from the saved journal.
No production mode, database connection, remote adapter, or user-supplied file path exists.
No .env file is loaded. Evidence remains in the reported temporary directory.`;
async function main() {
  const { values } = parseArgs({ options: { help: { type: "boolean" }, fixture: { type: "boolean" }, interrupt: { type: "string" } }, strict: true, allowPositionals: false });
  if (values.help) { console.log(usage); return; }
  if (!values.fixture) throw new Error("FIXTURE_REQUIRED");
  for (const key of Object.keys(process.env)) {
    if (/^(DATABASE_|STORAGE_|PGHOST$|PGPASSWORD$|AWS_|RAILWAY_|NODE_OPTIONS$|DOTENV_CONFIG_)/.test(key) && process.env[key]) throw new Error("CONNECTION_ENVIRONMENT_REFUSED");
  }
  const faults: Fault[] = ["before-intent", "after-intent", "after-delete", "before-commit", "after-commit"];
  if (values.interrupt && !faults.includes(values.interrupt as Fault)) throw new Error("UNKNOWN_INTERRUPTION");
  const store = createCleanupFixture(), manifest = store.manifest(), confirmation = manifestHash(manifest);
  let interrupted = false;
  try {
    await applyFixtureCleanup(store, manifest, confirmation, async fault => {
      if (values.interrupt === fault && !interrupted) { interrupted = true; throw new Error("SIMULATED_INTERRUPTION"); }
    });
  } catch (error) { if (!(error instanceof Error) || error.message !== "SIMULATED_INTERRUPTION") throw error; }
  const result = await applyFixtureCleanup(new FixtureStore(store.root), manifest, confirmation);
  const replay = await applyFixtureCleanup(new FixtureStore(store.root), manifest, confirmation);
  console.log(JSON.stringify({ ...result, root: store.root, interrupted, replay, auditEvents: store.state().audit.length,
    limits: ["Local disk and JSON records only. No real PostgreSQL or R2 cleanup proof.",
      "Exception recovery tested. A killed process leaves a fail-closed lock; no automatic lock takeover exists.",
      "Production concurrency and remote conditional-delete behavior remain release checks."] }, null, 2));
}
main().catch(() => { console.error("Cleanup refused or failed. This command supports local fixtures only. Use --help."); process.exitCode = 1; });
