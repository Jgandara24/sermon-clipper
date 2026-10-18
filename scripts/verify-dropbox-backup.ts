/** Verify one Dropbox round trip for the synthetic fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { LocalRuntime, unusedPort } from "./lib/rehearsal-runtime";
import { RehearsalPostgres } from "./lib/rehearsal-postgres";
import { schemaSnapshot } from "./lib/rehearsal-fixtures";

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

async function snapshot(pg: RehearsalPostgres, database: string) {
  const schemaState = await schemaSnapshot(pg, database);
  const tables = Object.keys(schemaState.counts).sort();
  const rows: Record<string, string> = {};
  for (const table of tables) {
    assert.match(table, /^[a-z_][a-z0-9_]*$/);
    rows[table] = hash((await pg.sql(database, `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM "${table}" t`)).stdout.trim());
  }
  const definitions = (await pg.sql(database, `SELECT jsonb_build_object(
    'extensions',(SELECT jsonb_agg(jsonb_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension),
    'functions',(SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.proname,p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'),
    'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
    'indexes',(SELECT jsonb_agg(indexdef ORDER BY tablename,indexname) FROM pg_indexes WHERE schemaname='public'))`)).stdout.trim();
  return { schemaState, rows, definitions: JSON.parse(definitions) };
}

async function main() {
  assert.equal(process.argv.length, 5, "Expected --verify, owned state file, and Dropbox ZIP.");
  assert.equal(process.argv[2], "--verify");
  const stateFile = realpathSync(process.argv[3]);
  const stateRoot = path.dirname(stateFile);
  assert.ok(stateRoot.startsWith("/private/tmp/encrypted-backup-"));
  assert.equal(path.basename(stateFile), "cloud-state.json");
  const zip = realpathSync(process.argv[4]);
  assert.equal(path.dirname(zip), "/Users/jakegandara/Downloads");
  assert.equal(path.basename(zip), "Pulpit Engine Backup Test - 2026-09-10.zip");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(realpathSync(state.root), stateRoot);
  assert.equal(realpathSync(state.recoveryKey), path.join(stateRoot, "saved-recovery.key"));

  const root = realpathSync(mkdtempSync("/private/tmp/dropbox-restore-"));
  const runtime = new LocalRuntime(root, [await unusedPort()]);
  const pg = new RehearsalPostgres(runtime, runtime.ports[0]);
  const passed: string[] = [];
  let complete = false;
  try {
    await runtime.verifyNetwork();
    passed.push("External network access refused during verification");
    const listed = (await runtime.run("/usr/bin/unzip", ["-Z1", zip])).stdout.trim().split("\n").sort();
    assert.deepEqual(listed, ["payload-0.age", "payload-1.age", "payload-2.age"]);
    const fresh = path.join(root, "fresh-download");
    mkdirSync(fresh, { mode: 0o700 });
    await runtime.run("/usr/bin/unzip", ["-j", zip, "payload-0.age", "payload-1.age", "payload-2.age", "-d", fresh]);
    assert.deepEqual(readdirSync(fresh).sort(), listed);
    for (const name of listed) assert.equal(hash(readFileSync(path.join(fresh, name))), state.encryptedSha256[name]);
    passed.push("Fresh Dropbox download contains only three expected encrypted files with matching SHA-256 values");

    const dump = path.join(root, "database.dump");
    const manifest = path.join(root, "manifest.json");
    const media = path.join(root, "synthetic.bin");
    for (const [input, output] of [["payload-0.age", dump], ["payload-1.age", manifest], ["payload-2.age", media]]) {
      await runtime.run("/usr/local/bin/age", ["-d", "-i", state.recoveryKey, "-o", output, path.join(fresh, input)]);
    }
    const privateManifest = JSON.parse(readFileSync(manifest, "utf8"));
    assert.equal(hash(readFileSync(dump)), state.dumpSha256);
    assert.equal(privateManifest.dumpSha256, state.dumpSha256);
    assert.equal(privateManifest.snapshotSha256, state.snapshotSha256);
    assert.equal(readFileSync(media).length, 192 * 1024);
    passed.push("Saved local recovery key decrypts all three freshly downloaded files");

    await pg.start();
    const database = await pg.create("restore");
    await pg.restore(database, { archive: dump, sha256: state.dumpSha256 });
    assert.equal(hash(JSON.stringify(await snapshot(pg, database))), state.snapshotSha256);
    passed.push("Fresh empty PostgreSQL database restores with matching schema and record snapshot");
    assert.equal((await pg.sql(database, "SELECT count(*) FROM transcripts")).stdout.trim(), "2");
    assert.equal((await pg.sql(database, "SELECT count(*) FROM usage_ledger")).stdout.trim(), "1");
    assert.equal((await pg.sql(database, "SELECT count(*) FROM processing_jobs")).stdout.trim(), "1");
    assert.equal((await pg.sql(database, "SELECT count(*) FROM cleanup_audit_events")).stdout.trim(), "1");
    passed.push("Captions, billing history, processing history, and cleanup audit evidence are present");
    complete = true;
  } finally {
    try { try { await pg.cleanup(); } finally { await runtime.stopAll(); } }
    finally {
      rmSync(stateRoot, { recursive: true });
      rmSync(root, { recursive: true });
      rmSync(zip);
    }
  }
  console.log(JSON.stringify({ status: complete ? "PASS" : "FAIL", time: new Date().toISOString(), passed, cleanup: "Local ZIP, private key, plaintext, encrypted staging files, and test databases removed" }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
