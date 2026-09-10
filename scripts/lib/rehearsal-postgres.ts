import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { databaseNames, assertFixtureDatabaseUrl, sha256 } from "./release-rehearsal";
import { LocalRuntime, type OwnedProcess } from "./rehearsal-runtime";

const pgBin = "/usr/local/opt/postgresql@17/bin";

/** Starts a new cluster, never connects to an existing user cluster. */
export class RehearsalPostgres {
  readonly data: string;
  private process?: OwnedProcess;
  private created = new Set<string>();
  private pristine = new Set<string>();
  private started = false;
  private initialized = false;
  constructor(readonly runtime: LocalRuntime, readonly port: number) {
    if (!runtime.ports.includes(port)) throw new Error("Postgres port is not allowed by the runtime.");
    this.data = path.join(runtime.root, "postgres-data");
  }
  async start() {
    if (this.started || existsSync(this.data)) throw new Error("Refusing an existing Postgres data directory.");
    await this.runtime.run(path.join(pgBin, "initdb"), ["-D", this.data, "-U", "p2_fixture", "-A", "trust", "--no-locale", "--encoding=UTF8"]);
    this.initialized = true;
    // Disable Unix sockets; all connections must pass the OS TCP allowlist.
    this.process = this.runtime.start(path.join(pgBin, "postgres"), ["-D", this.data, "-h", "127.0.0.1", "-p", String(this.port), "-k", "", "-c", "fsync=on"]);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (this.process.result) throw new Error(`Owned Postgres exited: ${this.process.result.stderr}`);
      try {
        const result = await this.runtime.run(path.join(pgBin, "psql"), this.args("postgres", ["-At", "-c", "SHOW data_directory"]), {}, 3000);
        if (result.stdout.trim() !== this.data) throw new Error("Unexpected Postgres data directory.");
        this.started = true;
        return;
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    throw new Error("Owned Postgres did not become ready.");
  }
  private args(database: string, tail: string[]) {
    return ["-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(this.port), "-U", "p2_fixture", "-d", database, ...tail];
  }
  private requireOwned(name: string) {
    if (!this.started || !this.created.has(name)) throw new Error("Database was not created by this controller.");
  }
  private recordOwnership() {
    writeFileSync(path.join(this.runtime.root, "database-ownership.json"), JSON.stringify({ data: this.data, port: this.port, created: [...this.created] }, null, 2), { mode: 0o600 });
  }
  async create(role: "baseline" | "restore" | "rollback" = "baseline") {
    if (!this.started) throw new Error("Owned Postgres is not ready.");
    const name = databaseNames(randomUUID().replaceAll("-", ""))[role];
    await this.runtime.run(path.join(pgBin, "psql"), this.args("postgres", ["-c", `CREATE DATABASE "${name}"`]));
    this.created.add(name); this.pristine.add(name); this.recordOwnership();
    return name;
  }
  url(name: string) {
    this.requireOwned(name);
    return assertFixtureDatabaseUrl(`postgresql://p2_fixture@127.0.0.1:${this.port}/${name}?schema=public`, name);
  }
  async sql(name: string, sql: string) {
    this.requireOwned(name);
    this.pristine.delete(name);
    // SQL is fixture code from the harness, never user media or remote input.
    return this.runtime.run(path.join(pgBin, "psql"), this.args(name, ["-At", "-c", sql]));
  }
  startSql(name: string, sql: string) {
    this.requireOwned(name); this.pristine.delete(name);
    return this.runtime.start(path.join(pgBin, "psql"), this.args(name, ["-At", "-c", sql]));
  }
  async migrate(name: string, cli: string, schema: string, resolve?: string) {
    this.requireOwned(name);
    this.runtime.assertExecutorsStopped();
    this.pristine.delete(name);
    const command = resolve ? ["migrate", "resolve", "--rolled-back", resolve] : ["migrate", "deploy"];
    return this.runtime.run(process.execPath, [cli, ...command, "--schema", schema], { DATABASE_URL: this.url(name) }, 60000, path.dirname(schema));
  }
  async dump(name: string) {
    this.requireOwned(name);
    const archive = path.join(this.runtime.root, `backup-${randomUUID()}.dump`);
    const startedAt = Date.now();
    await this.runtime.run(path.join(pgBin, "pg_dump"), ["-h", "127.0.0.1", "-p", String(this.port), "-U", "p2_fixture", "-d", name, "-Fc", "-f", archive]);
    const bytes = readFileSync(archive);
    return { archive, bytes: bytes.length, sha256: sha256(bytes), elapsedMs: Date.now() - startedAt };
  }
  async restore(name: string, backup: { archive: string; sha256: string }) {
    this.requireOwned(name);
    if (!this.pristine.has(name)) throw new Error("Restore requires a newly created untouched database.");
    if (path.dirname(backup.archive) !== this.runtime.root || sha256(readFileSync(backup.archive)) !== backup.sha256) throw new Error("Backup integrity check failed.");
    this.pristine.delete(name); // Even a failed restore target must never be reused.
    await this.runtime.run(path.join(pgBin, "pg_restore"), ["--exit-on-error", "--single-transaction", "-h", "127.0.0.1", "-p", String(this.port), "-U", "p2_fixture", "-d", name, backup.archive]);
  }
  async cleanup() {
    // Never DROP a caller-supplied database. Stop the dedicated server even if cleanup fails.
    try {
      for (const name of [...this.created]) {
        await this.runtime.run(path.join(pgBin, "psql"), this.args("postgres", ["-c", `DROP DATABASE "${name}" WITH (FORCE)`]));
        this.created.delete(name); this.recordOwnership();
      }
    } finally {
      if (this.process) await this.process.stop();
      this.started = false;
      if (this.initialized && (!this.process || !this.process.groupAlive())) {
        rmSync(this.data, { recursive: true });
        this.initialized = false;
      }
    }
  }
}
