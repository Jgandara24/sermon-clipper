/** Disposable local database proof. No application worker or remote database is used. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const migration = "20261016052924_agentic_editor_wave_3";
const repo = path.resolve(import.meta.dirname, "..");
const root = mkdtempSync(path.join(os.tmpdir(), "p4-db-"));
const data = path.join(root, "data");
const environment = Object.fromEntries(["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap(key =>
  process.env[key] ? [[key, process.env[key]!]] : []));

function run(command: string, args: string[], extra: Record<string, string> = {}) {
  return execFileSync(command, args, { cwd: repo, env: { ...environment, ...extra, NODE_ENV: "test", LC_ALL: "C" }, encoding: "utf8",
    timeout: 60000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function sql(database: string, statement: string) {
  return run("psql", ["-X", "-h", root, "-p", "55473", "-U", "p4_fixture", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-At", "-c", statement]);
}
function migrate(database: string, schema: string) {
  run(process.execPath, [path.join(repo, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", schema], {
    DATABASE_URL: `postgresql://p4_fixture@localhost:55473/${database}?host=${encodeURIComponent(root)}`,
  });
}

const seed = `
INSERT INTO users (id,email,updated_at) VALUES ('00000000-0000-4000-8000-000000000001','wave3@example.test',now());
INSERT INTO workspaces (id,name,owner_id,updated_at) VALUES
 ('00000000-0000-4000-8000-000000000002','Wave 3 fixture','00000000-0000-4000-8000-000000000001',now());
INSERT INTO source_videos (id,workspace_id,origin,width,height,duration_s,transcript_revision,updated_at) VALUES
 ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','upload',1920,1080,60,7,now());
INSERT INTO transcripts (id,source_video_id,language,provider,full_text,updated_at) VALUES
 ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','en','fixture','Grace and mercy',now());
INSERT INTO transcript_segments (transcript_id,idx,start_ms,end_ms,text,words,updated_at) VALUES
 ('00000000-0000-4000-8000-000000000004',0,0,1000,'Grace','[{"word":"Grace","startMs":0,"endMs":1000}]',now());
`;

function snapshot(database: string) {
  return sql(database, `SELECT jsonb_build_object(
    'source', (SELECT to_jsonb(s) FROM source_videos s LIMIT 1),
    'transcript', (SELECT to_jsonb(t)-'capabilities'-'provenance'-'provider_evidence'-'structure' FROM transcripts t LIMIT 1),
    'segment', (SELECT to_jsonb(s) FROM transcript_segments s LIMIT 1),
    'searchIndex', (SELECT indexdef FROM pg_indexes WHERE indexname='transcripts_search_vector_idx'),
    'trialDefault', (SELECT column_default FROM information_schema.columns WHERE table_name='workspaces' AND column_name='trial_ends_at')
  )`);
}

try {
  run("initdb", ["-D", data, "-U", "p4_fixture", "-A", "trust", "--no-locale", "--encoding=UTF8"]);
  appendFileSync(path.join(data, "postgresql.conf"), `\nlisten_addresses = ''\nunix_socket_directories = '${root.replaceAll("'", "''")}'\nport = 55473\n`);
  try {
    run("pg_ctl", ["-D", data, "-l", path.join(root, "postgres.log"), "-w", "start"]);
  } catch (error) {
    if (existsSync(path.join(root, "postgres.log"))) console.error(readFileSync(path.join(root, "postgres.log"), "utf8"));
    throw error;
  }
  assert.equal(sql("postgres", "SHOW data_directory"), data);
  sql("postgres", "CREATE DATABASE p4_clean");
  sql("postgres", "CREATE DATABASE p4_upgrade");

  const schema = path.join(repo, "prisma/schema.prisma");
  const baseline = path.join(root, "baseline");
  cpSync(path.join(repo, "prisma"), baseline, { recursive: true });
  for (const entry of readdirSync(path.join(baseline, "migrations"))) {
    if (entry !== "migration_lock.toml" && entry >= migration) {
      rmSync(path.join(baseline, "migrations", entry), { recursive: true });
    }
  }
  migrate("p4_upgrade", path.join(baseline, "schema.prisma"));
  assert.equal(sql("p4_upgrade", "SELECT to_regclass('media_regions') IS NULL"), "t");
  sql("p4_upgrade", seed);
  const before = snapshot("p4_upgrade");
  migrate("p4_upgrade", schema);
  assert.equal(snapshot("p4_upgrade"), before, "The upgrade changed historical data, search, or workspace defaults.");
  assert.equal(sql("p4_upgrade", "SELECT capabilities IS NULL AND provenance IS NULL AND provider_evidence IS NULL AND structure IS NULL FROM transcripts"), "t");
  assert.equal(sql("p4_upgrade", "SELECT search_vector @@ plainto_tsquery('english','mercy') FROM transcripts"), "t");

  migrate("p4_clean", schema);
  for (const database of ["p4_clean", "p4_upgrade"]) {
    assert.equal(sql(database, `SELECT count(*) FROM _prisma_migrations WHERE migration_name='${migration}' AND finished_at IS NOT NULL`), "1");
    assert.equal(sql(database, "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('media_regions','derived_media_artifacts')"), "2");
    // A repeated deploy must remain safe and must not duplicate the history row.
    migrate(database, schema);
    assert.equal(sql(database, `SELECT count(*) FROM _prisma_migrations WHERE migration_name='${migration}'`), "1");
  }
  const report = {
    recordedAt: new Date().toISOString(), migration, cleanInstall: "PASS", populatedUpgrade: "PASS",
    historicalDataPreserved: true, sourceRevisionPreserved: true, searchColumnAndIndexPreserved: true,
    workspaceDefaultPreserved: true, unknownLegacyProvenance: true, repeatedDeploy: "PASS",
    scope: "Disposable local PostgreSQL only. No deployment or storage deletion proof.",
  };
  const output = process.argv[2];
  if (output) writeFileSync(path.resolve(output), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Also stop a server that started despite a startup observation failure.
  let running = false;
  try { run("pg_ctl", ["-D", data, "status"]); running = true; } catch { /* No server reported. */ }
  if (running) run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  if (existsSync(path.join(data, "postmaster.pid"))) throw new Error(`Owned PostgreSQL status is uncertain. Inspect ${root}.`);
  rmSync(root, { recursive: true });
}
