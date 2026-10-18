/** Local synthetic backup proof. No production URLs, media, or cloud APIs. */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LocalRuntime, unusedPort } from "./lib/rehearsal-runtime";
import { RehearsalPostgres } from "./lib/rehearsal-postgres";
import { seedRehearsal, schemaSnapshot } from "./lib/rehearsal-fixtures";

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function main() {
  const mode = process.argv[2];
  assert.equal(process.argv.length, 3, "Use one mode only; no input paths or database URLs.");
  assert.ok(mode === "--local" || mode === "--prepare-dropbox", "Use --local or --prepare-dropbox.");
  process.umask(0o077);
  const root = mkdtempSync("/private/tmp/encrypted-backup-");
  const runtime = new LocalRuntime(root, [await unusedPort()]);
  const pg = new RehearsalPostgres(runtime, runtime.ports[0]);
  const passed: string[] = [];
  let complete = false;
  let version = "";
  let counts: unknown;
  let cloudState: Record<string, unknown> | undefined;
  const files: string[] = [];
  const file = (name: string) => { const p = path.join(root, name); files.push(p); return p; };
  const reject = async (name: string, action: () => Promise<unknown>, reason: RegExp) => {
    await assert.rejects(action, error => reason.test(String(error))); passed.push(name);
  };
  try {
    await runtime.verifyNetwork();
    passed.push("External, child-process, and unlisted localhost network access refused");
    version = (await runtime.run("/usr/local/bin/age", ["--version"])).stdout.trim();
    const original = file("original.key"), recovery = file("saved-recovery.key"), wrong = file("wrong.key");
    await runtime.run("/usr/local/bin/age-keygen", ["-o", original]);
    const recipient = (await runtime.run("/usr/local/bin/age-keygen", ["-y", original])).stdout.trim();
    assert.match(recipient, /^age1[a-z0-9]+$/);
    cpSync(original, recovery, { errorOnExist: true, force: false });
    rmSync(original);
    await runtime.run("/usr/local/bin/age-keygen", ["-o", wrong]);
    passed.push("Recovery uses a separate local key copy after original key removal");
    await pg.start();
    const db = await pg.create();
    const schema = path.join(root, "prisma/schema.prisma");
    mkdirSync(path.dirname(schema));
    cpSync(path.resolve("prisma/schema.prisma"), schema);
    cpSync(path.resolve("prisma/migrations"), path.join(root, "prisma/migrations"), { recursive: true });
    await pg.migrate(db, path.resolve("node_modules/prisma/build/index.js"), schema);
    await seedRehearsal(pg, db);
    const session = randomUUID();
    await pg.sql(db, `INSERT INTO usage_ledger(id,workspace_id,kind,minutes_delta,balance_after,note,updated_at)
      VALUES('${randomUUID()}','${id(2)}','grant',5,5,'Synthetic billing history',now());
      INSERT INTO source_media_gates(source_id) SELECT id FROM source_videos;
      INSERT INTO source_copy_operations(id,plan_hash,manifest,source_video_id,storage_key,state,retain_until)
      VALUES('${randomUUID()}','fixture','{}','${randomUUID()}','fixture/copy','PREPARED',now()+interval '1 day');
      INSERT INTO processing_jobs(id,project_id,type,state,idempotency_key,updated_at)
      VALUES('${randomUUID()}','${id(102)}','transcribe','succeeded','synthetic-backup-job',now());
      BEGIN;
      INSERT INTO source_media_sessions(id,source_id,generation,owner_id,purpose)
      VALUES('${session}','${id(101)}',0,'${id(1)}','fixture');
      INSERT INTO cleanup_audit_events(id,operation_id,target_type,target_id,revision,action,actor_id,evidence,created_at)
      VALUES('${randomUUID()}',NULL,'session','${session}',0,'ACTIVE','${id(1)}','{}',now());
      COMMIT;`);
    const snapshot = async (name: string) => {
      const schemaState = await schemaSnapshot(pg, name);
      const tables = Object.keys(schemaState.counts).sort();
      const rows: Record<string, string> = {};
      for (const table of tables) {
        assert.match(table, /^[a-z_][a-z0-9_]*$/);
        rows[table] = hash((await pg.sql(name, `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM "${table}" t`)).stdout.trim());
      }
      const definitions = (await pg.sql(name, `SELECT jsonb_build_object(
        'extensions',(SELECT jsonb_agg(jsonb_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension),
        'functions',(SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.proname,p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'),
        'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal),
        'indexes',(SELECT jsonb_agg(indexdef ORDER BY tablename,indexname) FROM pg_indexes WHERE schemaname='public'))`)).stdout.trim();
      return { schemaState, rows, definitions: JSON.parse(definitions) };
    };
    const before = await snapshot(db); counts = before.schemaState.counts;
    const backup = await pg.dump(db); files.push(backup.archive);
    const listing = await runtime.run("/usr/local/opt/postgresql@17/bin/pg_restore", ["--list", backup.archive]);
    assert.match(listing.stdout, /TABLE DATA public usage_ledger/);
    passed.push("Custom archive listing contains billing data");
    const manifest = file("manifest.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, synthetic: true, dumpSha256: backup.sha256, snapshotSha256: hash(JSON.stringify(before)) }));
    const media = file("synthetic.bin"); writeFileSync(media, randomBytes(192 * 1024));
    const payloads = [backup.archive, manifest, media];
    const recovered: string[] = [];
    const encryptedFiles: string[] = [];
    for (const [index, input] of payloads.entries()) {
      const encrypted = file(`payload-${index}.age`), transfer = file(`local-copy-${index}.age`), output = file(`restored-${index}.bin`);
      await runtime.run("/usr/local/bin/age", ["-r", recipient, "-o", encrypted, input]);
      encryptedFiles.push(encrypted);
      cpSync(encrypted, transfer, { errorOnExist: true, force: false });
      assert.equal(hash(readFileSync(transfer)), hash(readFileSync(encrypted)));
      await runtime.run("/usr/local/bin/age", ["-d", "-i", recovery, "-o", output, transfer]);
      assert.equal(hash(readFileSync(output)), hash(readFileSync(input)));
      recovered.push(output);
    }
    passed.push("Database archive, private manifest, and synthetic binary encrypt and recover with exact SHA-256 matches");
    const recoveredManifest = JSON.parse(readFileSync(recovered[1], "utf8"));
    assert.equal(recoveredManifest.dumpSha256, hash(readFileSync(recovered[0])));
    assert.equal(recoveredManifest.snapshotSha256, hash(JSON.stringify(before)));
    passed.push("Recovered manifest matches archive and database snapshot");
    const restored = await pg.create("restore");
    await pg.restore(restored, { archive: recovered[0], sha256: backup.sha256 });
    assert.deepEqual(await snapshot(restored), before);
    passed.push("Fresh database restore preserves all public table rows, billing, captions, editor state, journals, migrations, sequences, constraints, functions, triggers, and indexes");
    await reject("Restored database refuses direct gate deletion", () => pg.sql(restored, "DELETE FROM source_media_gates"), /CLEANUP_HISTORY_IMMUTABLE/);
    await reject("Restored audit history cannot be deleted", () => pg.sql(restored, "DELETE FROM cleanup_audit_events"), /CLEANUP_HISTORY_IMMUTABLE/);
    await reject("Restored foreign key rejects missing project", () => pg.sql(restored, `INSERT INTO processing_jobs(id,project_id,type,idempotency_key,updated_at) VALUES('${randomUUID()}','${randomUUID()}','transcribe','invalid-fixture',now())`), /foreign key constraint/);
    await pg.sql(restored, "BEGIN; UPDATE usage_ledger SET note='Rollback-only fixture'; ROLLBACK;");
    assert.deepEqual(await snapshot(restored), before);
    passed.push("Valid rollback-only edit succeeds; fixture snapshot stays unchanged");
    await reject("Populated restore target refused", () => pg.restore(restored, { archive: recovered[0], sha256: backup.sha256 }), /newly created untouched/);
    const attemptDecrypt = async (input: string, key: string) => {
      const output = file(`failed-${randomUUID()}.bin`);
      try { await runtime.run("/usr/local/bin/age", ["-d", "-i", key, "-o", output, input]); }
      finally { rmSync(output, { force: true }); assert.equal(existsSync(output), false); }
    };
    await reject("Wrong key refused; output removed", () => attemptDecrypt(path.join(root, "payload-2.age"), wrong), /no identity matched/);
    const damaged = file("damaged.age");
    const bytes = readFileSync(path.join(root, "payload-2.age")); bytes[bytes.length - 1] ^= 1; writeFileSync(damaged, bytes);
    await reject("Damaged ciphertext refused; partial plaintext removed", () => attemptDecrypt(damaged, recovery), /failed to decrypt|authentication/);
    const cut = file("truncated.age"); writeFileSync(cut, bytes.subarray(0, bytes.length - 200));
    await reject("Truncated ciphertext refused; partial plaintext removed", () => attemptDecrypt(cut, recovery), /failed to decrypt|unexpected EOF/);
    const truncated = file("truncated.dump");
    const dumpBytes = readFileSync(backup.archive); writeFileSync(truncated, dumpBytes.subarray(0, Math.floor(dumpBytes.length / 2)));
    const failed = await pg.create("restore");
    await reject("Truncated dump fails atomic restore", () => pg.restore(failed, { archive: truncated, sha256: hash(readFileSync(truncated)) }), /pg_restore: error/);
    assert.equal((await pg.sql(failed, "SELECT count(*) FROM pg_tables WHERE schemaname='public'")).stdout.trim(), "0");
    passed.push("Failed atomic restore leaves no public tables");
    await reject("Failed restore target cannot be reused", () => pg.restore(failed, { archive: recovered[0], sha256: backup.sha256 }), /newly created untouched/);
    if (mode === "--prepare-dropbox") {
      cloudState = {
        root,
        recoveryKey: recovery,
        recipient,
        uploadFiles: encryptedFiles,
        encryptedSha256: Object.fromEntries(encryptedFiles.map(item => [path.basename(item), hash(readFileSync(item))])),
        dumpSha256: backup.sha256,
        snapshotSha256: hash(JSON.stringify(before)),
      };
      writeFileSync(path.join(root, "cloud-state.json"), JSON.stringify(cloudState, null, 2));
    }
    complete = true;
  } finally {
    try { try { await pg.cleanup(); } finally { await runtime.stopAll(); } }
    catch (error) { complete = false; throw error; }
    finally {
      const keep = mode === "--prepare-dropbox" ? new Set([path.join(root, "saved-recovery.key"), path.join(root, "payload-0.age"), path.join(root, "payload-1.age"), path.join(root, "payload-2.age")]) : new Set<string>();
      for (const p of files) if (!keep.has(p)) rmSync(p, { force: true });
      assert(files.filter(p => !keep.has(p)).every(p => !existsSync(p)), "Sensitive fixture cleanup failed");
      passed.push(mode === "--prepare-dropbox" ? "Plaintext payloads and unused keys removed; encrypted upload files and recovery key retained outside Dropbox" : "Disposable keys and all plaintext and encrypted payloads removed");
      const report = { status: complete ? "PASS" : "FAIL", ageVersion: version, time: new Date().toISOString(), passed, counts, limits: ["No Dropbox transfer or account access", "No production access", "Local key copy only; no password-manager recovery proof", "Small synthetic data only; no production size or timing proof"] };
      writeFileSync(path.join(root, "results.json"), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ...report, report: path.join(root, "results.json"), cloudState }, null, 2));
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
