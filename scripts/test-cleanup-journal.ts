/** Disposable PostgreSQL proof. No application modules, media, or caller database URLs. */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { LocalRuntime, unusedPort } from "./lib/rehearsal-runtime";
import { canonicalManifest } from "./lib/cleanup-protocol";
import { RehearsalPostgres } from "./lib/rehearsal-postgres";

const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const migration = "20260910140000_cleanup_journal";
async function main() {
  assert.deepEqual(process.argv.slice(2), ["--local"], "Use --local only. No database URL or path is accepted.");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cleanup-journal-")));
  const port = await unusedPort();
  const runtime = new LocalRuntime(root, [port]);
  const pg = new RehearsalPostgres(runtime, port);
  const passed: string[] = [];
  let complete = false;
  try {
    await runtime.verifyNetwork();
    passed.push("OS network refusal: external, inherited child, unlisted local port");
    await pg.start();
    const db = await pg.create();
    const sql = async (s: string) => (await pg.sql(db, s)).stdout.trim();
    const check = async (name: string, s: string, expected?: string) => {
      const actual = await sql(s); if (expected !== undefined) assert.equal(actual, expected);
      passed.push(name);
    };
    const reject = async (name: string, s: string, reason: string) => {
      await assert.rejects(() => sql(s), e => String(e).includes(reason)); passed.push(name);
    };
    const migrations = path.resolve("prisma/migrations");
    const folders = readdirSync(migrations).filter(n => /^\d/.test(n)).sort();
    for (const folder of folders.filter(n => n !== migration)) await sql(readFileSync(path.join(migrations, folder, "migration.sql"), "utf8"));
    const user = randomUUID(), ws = randomUUID(), op = randomUUID();
    const sources = [randomUUID(), randomUUID()], projects = [randomUUID(), randomUUID()];
    const fields = ["storage_key", "audio_key", "thumbnail_key"];
    const items = sources.flatMap((sourceId, i) => fields.map((field, j) => ({ sourceId, projectId: projects[i], field,
      key: `fixture/${i}/${j}`, bytes: 12, sha256: hash("fixture"), etag: "fixture-etag",
      headModifiedAt: "2026-09-10T00:00:00Z", listModifiedAt: "2026-09-10T00:00:00Z", metadata: { contentType: "application/octet-stream", custom: {} } })));
    await sql(`INSERT INTO users(id,email,updated_at) VALUES('${user}','fixture@example.invalid',now());
      INSERT INTO workspaces(id,name,owner_id,updated_at) VALUES('${ws}','Synthetic','${user}',now());`);
    for (let i = 0; i < 2; i++) await sql(`INSERT INTO source_videos(id,workspace_id,origin,storage_key,audio_key,thumbnail_key,duration_s,updated_at)
      VALUES('${sources[i]}','${ws}','upload','fixture/${i}/0','fixture/${i}/1','fixture/${i}/2',3,now());
      INSERT INTO projects(id,workspace_id,source_video_id,name,status,updated_at) VALUES('${projects[i]}','${ws}','${sources[i]}','Synthetic','failed',now());
      INSERT INTO transcripts(id,source_video_id,language,provider,full_text,updated_at) VALUES('${randomUUID()}','${sources[i]}','en','fixture','Preserve this synthetic transcript',now());`);
    const snapshotSql = "SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM transcripts t";
    const before = await sql(snapshotSql);
    await sql(readFileSync(path.join(migrations, migration, "migration.sql"), "utf8"));
    await check("populated migration preserves transcripts", snapshotSql, before);
    await check("backfill creates ACTIVE gates only", "SELECT count(*) FROM source_media_gates WHERE state='ACTIVE' AND generation=0 AND operation_id IS NULL", "2");
    const unusedSource = randomUUID();
    await sql(`INSERT INTO source_videos(id,workspace_id,origin,updated_at) VALUES('${unusedSource}','${ws}','upload',now());INSERT INTO source_media_gates(source_id) VALUES('${unusedSource}')`);
    await reject("direct gate deletion refused", `DELETE FROM source_media_gates WHERE source_id='${unusedSource}'`, "CLEANUP_HISTORY_IMMUTABLE");
    await check("unused source deletion preserves existing app behavior", `DELETE FROM source_videos WHERE id='${unusedSource}'`);
    await check("unused gate removed with its source", `SELECT count(*) FROM source_media_gates WHERE source_id='${unusedSource}'`, "0");
    const manifest = canonicalManifest({ version: 1, createdAt: "2026-09-10T00:00:00Z", approvalExpiresAt: "2026-09-10T00:20:00Z", operationId: op, operatorId: user, workspaceId: ws, identity: { environment: "local-disposable", provider: "fixture", account: "fixture-account", bucket: "fixture-bucket", endpoint: "fixture://cleanup" },
      backupManifestHash: hash("backup"), preservedRecordsHash: hash("preserved"), items });
    const audit = (kind: string, id: string, rev: number, action: string, operation: string | null = op) =>
      `INSERT INTO cleanup_audit_events(id,operation_id,target_type,target_id,revision,action,actor_id,evidence,created_at) VALUES('${randomUUID()}',${operation ? q(operation) : "NULL"},'${kind}','${id}',${rev},'${action}','${user}','{}',now());`;
    const objects = items.map(() => randomUUID());
    const prepare = `INSERT INTO cleanup_operations(id,workspace_id,operator_id,canonical_manifest,manifest,manifest_hash,backup_manifest_hash,preserved_records_hash,storage_identity)
      VALUES('${op}','${ws}','${user}',${q(manifest)},${q(manifest)},'${hash(manifest)}','${hash("backup")}','${hash("preserved")}',encode(digest((${q(manifest)}::jsonb->'identity')::text,'sha256'),'hex'));
      ${audit("operation", op, 0, "PREPARED")}`;
    const insertObjects = items.map((item, i) => `INSERT INTO cleanup_objects(id,operation_id,ordinal,source_id,project_id,field_name,storage_key,bytes,sha256,etag,head_modified_at,list_modified_at,metadata)
      VALUES('${objects[i]}','${op}',${i},'${item.sourceId}','${item.projectId}','${item.field}','${item.key}',12,'${item.sha256}','fixture-etag','${item.headModifiedAt}','${item.listModifiedAt}',${q(JSON.stringify(item.metadata))});${audit("object", objects[i], 0, "PLANNED")}`);
    await reject("five objects refused at commit", `BEGIN;${prepare}${insertObjects.slice(0, 5).join("")}COMMIT;`, "CLEANUP_SIX_OBJECT_SCOPE_REQUIRED");
    await reject("wrong source field refused", `BEGIN;${prepare}${insertObjects.join("").replace("'fixture/0/0',12", "'wrong',12")}COMMIT;`, "CLEANUP_MANIFEST_ITEM_MISMATCH");
    await reject("seventh object refused", `BEGIN;${prepare}${insertObjects.join("")}${insertObjects[0].replaceAll(objects[0], randomUUID()).replace(",0,", ",6,")}COMMIT;`, "check constraint");
    await reject("duplicate field refused", `BEGIN;${prepare}${insertObjects.join("").replace("'audio_key','fixture/0/1'", "'storage_key','fixture/0/1'")}COMMIT;`, "duplicate key");
    await reject("wrong manifest hash refused", `BEGIN;${prepare.replace(hash(manifest), hash("wrong"))}${insertObjects.join("")}COMMIT;`, "check constraint");
    const otherWorkspace = randomUUID();
    await sql(`INSERT INTO workspaces(id,name,owner_id,updated_at) VALUES('${otherWorkspace}','Other fixture','${user}',now())`);
    await reject("cross-workspace source refused", `BEGIN;UPDATE source_videos SET workspace_id='${otherWorkspace}' WHERE id='${sources[0]}';${prepare}${insertObjects.join("")}COMMIT;`, "CLEANUP_SOURCE_REFERENCE_MISMATCH");
    await check("six exact objects accepted", `BEGIN;${prepare}${insertObjects.join("")}COMMIT;`);
    await reject("journal deletion refused", `DELETE FROM cleanup_objects WHERE id='${objects[0]}'`, "CLEANUP_HISTORY_IMMUTABLE");
    await reject("scope edit refused", `UPDATE cleanup_objects SET storage_key='other',revision=1 WHERE id='${objects[0]}'`, "CLEANUP_SCOPE_IMMUTABLE");
    await reject("state jump refused", `UPDATE cleanup_operations SET state='COMPLETE',revision=1 WHERE id='${op}'`, "CLEANUP_TRANSITION_INVALID");
    const opState = (state: string, rev: number) => `UPDATE cleanup_operations SET state='${state}',revision=${rev} WHERE id='${op}';${audit("operation", op, rev, state)}`;
    await reject("audit required at commit", `UPDATE cleanup_operations SET state='QUIESCING',revision=1 WHERE id='${op}'`, "CLEANUP_AUDIT_REQUIRED");
    // A previously committed event must not stand in for an atomic audit write.
    const staleSession = randomUUID();
    await sql(audit("session", staleSession, 0, "ACTIVE", null));
    await reject("previous transaction audit cannot authorize a transition", `INSERT INTO source_media_sessions(id,source_id,generation,owner_id,purpose) VALUES('${staleSession}','${sources[0]}',0,'${user}','fixture')`, "CLEANUP_AUDIT_TRANSACTION_REQUIRED");
    await check("missing audit rolled operation back", `SELECT state FROM cleanup_operations WHERE id='${op}'`, "PREPARED");
    const approval = randomUUID();
    const grant = (expiry: string, digest = hash(manifest)) => `INSERT INTO cleanup_approvals VALUES('${approval}','${op}','${digest}','${user}','EXECUTE',now(),now()+interval '${expiry}',NULL);`;
    await reject("approval over 30 minutes refused", grant("31 minutes"), "check constraint");
    await reject("approval wrong hash refused", grant("10 minutes", hash("wrong")), "foreign key constraint");
    await check("approval grant with audit", `BEGIN;${grant("10 minutes")}${audit("approval", approval, 0, "GRANTED")}COMMIT;`);
    await reject("approval extension refused", `UPDATE cleanup_approvals SET expires_at=expires_at+interval '1 minute' WHERE id='${approval}'`, "CLEANUP_APPROVAL_IMMUTABLE");
    await check("approval revocation with audit", `BEGIN;UPDATE cleanup_approvals SET revoked_at=now() WHERE id='${approval}';${audit("approval", approval, 1, "REVOKED")}COMMIT;`);
    await reject("parent deletion cannot erase journal", `DELETE FROM projects WHERE id='${projects[0]}'`, "foreign key constraint");
    await sql("CREATE ROLE cleanup_unprivileged NOLOGIN");
    await reject("ungranted role cannot read private journal", "SET ROLE cleanup_unprivileged;SELECT * FROM cleanup_operations", "permission denied");
    const session = randomUUID();
    const admit = (id: string, generation = 0) => `INSERT INTO source_media_sessions(id,source_id,generation,owner_id,purpose) VALUES('${id}','${sources[0]}',${generation},'${user}','fixture');${audit("session", id, 0, "ACTIVE", null)}`;
    await reject("stale generation refused", `BEGIN;${admit(randomUUID(), 1)}COMMIT;`, "CLEANUP_SOURCE_NOT_ACTIVE");
    await check("ACTIVE session admission", `BEGIN;${admit(session)}COMMIT;`);
    const gate = (i: number, state: string, generation: number) => `UPDATE source_media_gates SET state='${state}',generation=${generation},operation_id='${op}' WHERE source_id='${sources[i]}';${audit("gate", sources[i], generation, state)}`;
    await check("quiesce while draining", `BEGIN;${opState("QUIESCING", 1)}${gate(0, "QUIESCING", 1)}${gate(1, "QUIESCING", 1)}COMMIT;`);
    await reject("abort with unresolved gates or sessions refused", `BEGIN;${opState("ABORTED", 2)}COMMIT;`, "CLEANUP_ABORT_UNRESOLVED");
    await reject("quiescing admission refused", `BEGIN;${admit(randomUUID(), 1)}COMMIT;`, "CLEANUP_SOURCE_NOT_ACTIVE");
    await reject("open session blocks retirement", `BEGIN;${gate(0, "RETIRED", 2)}COMMIT;`, "CLEANUP_SESSION_OPEN");
    await check("session uncertainty recorded", `BEGIN;UPDATE source_media_sessions SET state='UNCERTAIN',revision=1 WHERE id='${session}';${audit("session", session, 1, "UNCERTAIN", null)}COMMIT;`);
    await reject("uncertain session blocks retirement", `BEGIN;${gate(0, "RETIRED", 2)}COMMIT;`, "CLEANUP_SESSION_OPEN");
    await check("session completion needs evidence", `BEGIN;UPDATE source_media_sessions SET state='COMPLETE',revision=2,terminal_evidence='{"drained":true}' WHERE id='${session}';${audit("session", session, 2, "COMPLETE", null)}COMMIT;`);
    await check("retire drained sources", `BEGIN;${gate(0, "RETIRED", 2)}${gate(1, "RETIRED", 2)}COMMIT;`);
    await reject("READY without reservations refused", `BEGIN;${opState("READY", 2)}COMMIT;`, "CLEANUP_RESERVATIONS_REQUIRED");
    const reservations = items.map(() => randomUUID());
    const reserve = (id: string, key: string) => `INSERT INTO media_key_reservations(id,storage_identity,storage_key,operation_id) SELECT '${id}',storage_identity,'${key}',id FROM cleanup_operations WHERE id='${op}';${audit("reservation", id, 0, "HELD")}`;
    const first = pg.startSql(db, `BEGIN;SET application_name='cleanup_claim_first';${reserve(reservations[0], items[0].key)}SELECT pg_sleep(3);COMMIT;`);
    const waitFor = async (query: string) => {
      for (let i = 0; i < 100; i++) { if (await sql(query) === "1") return; await new Promise(r => setTimeout(r, 20)); }
      throw new Error("Concurrent SQL did not reach its expected wait.");
    };
    await waitFor("SELECT count(*) FROM pg_stat_activity WHERE application_name='cleanup_claim_first' AND wait_event='PgSleep'");
    const contender = pg.startSql(db, `BEGIN;SET application_name='cleanup_claim_second';${reserve(randomUUID(), items[0].key)}COMMIT;`);
    await waitFor("SELECT count(*) FROM pg_stat_activity WHERE application_name='cleanup_claim_second' AND wait_event_type='Lock'");
    assert.equal((await first.wait(10000)).code, 0);
    const conflict = await contender.wait(10000);
    assert.notEqual(conflict.code, 0); assert.match(conflict.stderr, /duplicate key/);
    passed.push("two connections serialize competing key claims");
    await check("reserve remaining five keys", `BEGIN;${items.slice(1).map((item, i) => reserve(reservations[i + 1], item.key)).join("")}COMMIT;`);
    await reject("duplicate held key refused", `BEGIN;${reserve(randomUUID(), items[0].key)}COMMIT;`, "duplicate key");
    await check("READY and APPLYING", `BEGIN;${opState("READY", 2)}${opState("APPLYING", 3)}COMMIT;`);
    const objState = (i: number, state: string, rev: number, evidence = "") => `UPDATE cleanup_objects SET state='${state}',revision=${rev}${evidence} WHERE id='${objects[i]}';${audit("object", objects[i], rev, state)}`;
    await check("durable intent", `BEGIN;${objState(0, "INTENT_RECORDED", 1)}COMMIT;`);
    await reject("absence without evidence refused", `BEGIN;${objState(0, "ABSENCE_CONFIRMED", 2)}COMMIT;`, "check constraint");
    await check("absence evidence accepted", `BEGIN;${objState(0, "ABSENCE_CONFIRMED", 2, ",absence_evidence='{\"fixtureAbsent\":true}'")}COMMIT;`);
    const clear = (i: number) => `UPDATE source_videos SET ${items[i].field}=NULL WHERE id='${items[i].sourceId}';`;
    await reject("field and journal roll back without audit", `BEGIN;${clear(0)}UPDATE cleanup_objects SET state='RECORD_COMMITTED',revision=3 WHERE id='${objects[0]}';COMMIT;`, "CLEANUP_AUDIT_REQUIRED");
    await check("source key preserved after failed commit", `SELECT storage_key FROM source_videos WHERE id='${sources[0]}'`, items[0].key);
    await check("atomic record commit", `BEGIN;${clear(0)}${objState(0, "RECORD_COMMITTED", 3)}COMMIT;`);
    await reject("early completion refused", `BEGIN;${opState("COMPLETE", 4)}COMMIT;`, "CLEANUP_COMPLETION_INVALID");
    await check("uncertain operation remains blocked", `BEGIN;${opState("NEEDS_RECONCILIATION", 4)}COMMIT;`);
    await reject("uncertainty prevents reservation release", `BEGIN;UPDATE media_key_reservations SET state='RELEASED',revision=1,resolution='{"done":true}' WHERE id='${reservations[0]}';${audit("reservation", reservations[0], 1, "RELEASED")}COMMIT;`, "CLEANUP_RESERVATIONS_REQUIRED");
    await check("explicit reconciliation state", `BEGIN;${opState("APPLYING", 5)}COMMIT;`);
    for (let i = 1; i < 6; i++) await sql(`BEGIN;${objState(i, "INTENT_RECORDED", 1)}${objState(i, "ABSENCE_CONFIRMED", 2, ",absence_evidence='{\"fixtureAbsent\":true}'")}${clear(i)}${objState(i, "RECORD_COMMITTED", 3)}COMMIT;`);
    await check("complete six records", `BEGIN;${opState("COMPLETE", 6)}COMMIT;`);
    await reject("used source deletion retains journal", `DELETE FROM source_videos WHERE id='${sources[0]}'`, "foreign key constraint");
    await reject("restore disabled", `BEGIN;${gate(0, "RESTORING", 3)}COMMIT;`, "CLEANUP_RESTORE_DISABLED");
    await reject("audit truncate refused", "TRUNCATE cleanup_audit_events", "CLEANUP_HISTORY_IMMUTABLE");
    await reject("audit immutable", "DELETE FROM cleanup_audit_events", "CLEANUP_HISTORY_IMMUTABLE");
    await check("transcripts preserved after fixture transitions", snapshotSql, before);
    const backup = await pg.dump(db), restored = await pg.create("restore");
    await pg.restore(restored, backup);
    assert.equal((await pg.sql(restored, "SELECT state FROM cleanup_operations")).stdout.trim(), "COMPLETE");
    passed.push("dump and restore preserve journal and constraints");
    await assert.rejects(() => pg.sql(restored, "DELETE FROM cleanup_audit_events"), e => String(e).includes("CLEANUP_HISTORY_IMMUTABLE"));
    const empty = await pg.create("rollback");
    for (const folder of folders.filter(n => n !== migration)) await pg.sql(empty, readFileSync(path.join(migrations, folder, "migration.sql"), "utf8"));
    const candidate = readFileSync(path.join(migrations, migration, "migration.sql"), "utf8");
    await assert.rejects(() => pg.sql(empty, candidate.replace("COMMIT;", "SELECT 1/0;COMMIT;")), e => String(e).includes("division by zero"));
    assert.equal((await pg.sql(empty, "SELECT to_regclass('cleanup_operations') IS NULL")).stdout.trim(), "t");
    passed.push("failed migration rolls back all journal DDL");
    await pg.sql(empty, candidate);
    passed.push("empty database migrates through full history");
    // Use a separate owned schema tree. Never load the repository .env.
    const schemaRoot = path.join(root, "prisma");
    mkdirSync(path.join(schemaRoot, "migrations"), { recursive: true });
    cpSync(path.resolve("prisma/schema.prisma"), path.join(schemaRoot, "schema.prisma"));
    cpSync(path.join(migrations, "migration_lock.toml"), path.join(schemaRoot, "migrations/migration_lock.toml"));
    for (const folder of folders.filter(n => n !== migration)) cpSync(path.join(migrations, folder), path.join(schemaRoot, "migrations", folder), { recursive: true });
    const deployed = await pg.create();
    const cli = path.resolve("node_modules/prisma/build/index.js"), schemaPath = path.join(schemaRoot, "schema.prisma");
    await pg.migrate(deployed, cli, schemaPath);
    const candidateDir = path.join(schemaRoot, "migrations", migration);
    mkdirSync(candidateDir);
    writeFileSync(path.join(candidateDir, "migration.sql"), candidate.replace("COMMIT;", "SELECT 1/0;COMMIT;"));
    await assert.rejects(() => pg.migrate(deployed, cli, schemaPath), e => /division by zero|current transaction is aborted/.test(String(e)));
    assert.equal((await pg.sql(deployed, "SELECT to_regclass('cleanup_operations') IS NULL")).stdout.trim(), "t");
    await assert.rejects(() => pg.migrate(deployed, cli, schemaPath), e => String(e).includes("P3009"));
    passed.push("Prisma failed migration rolls back and blocks redeploy");
    await pg.migrate(deployed, cli, schemaPath, migration);
    writeFileSync(path.join(candidateDir, "migration.sql"), candidate);
    await pg.migrate(deployed, cli, schemaPath);
    const ledger = await pg.sql(deployed, `SELECT count(*) FROM _prisma_migrations WHERE migration_name='${migration}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    assert.equal(ledger.stdout.trim(), "1");
    await pg.migrate(deployed, cli, schemaPath);
    passed.push("Prisma resolve and corrected deploy succeed; repeat deploy is unchanged");
    complete = true;
  } finally {
    try { await pg.cleanup(); } finally { await runtime.stopAll(); }
    writeFileSync(path.join(root, "results.json"), JSON.stringify({ complete, passed, cleanupComplete: true }, null, 2));
    console.log(JSON.stringify({ passed: passed.length, evidence: root, checks: passed }, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
