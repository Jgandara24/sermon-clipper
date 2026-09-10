import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { assertFixtureDatabaseUrl, sha256 } from "./release-rehearsal";

export function networkProfile(ports: number[]) {
  if (!ports.length || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error("Invalid fixture ports.");
  return `(version 1)\n(allow default)\n(deny network*)\n${[...new Set(ports)].map(port =>
    `(allow network-outbound (remote ip "localhost:${port}"))\n(allow network-bind network-inbound (local ip "localhost:${port}"))`,
  ).join("\n")}\n`;
}

export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local port.");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

export type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
export class OwnedProcess {
  readonly child: ChildProcess;
  readonly done: Promise<ProcessResult>;
  readonly startedAt = new Date().toISOString();
  readonly parentPid = process.pid;
  result?: ProcessResult;
  private stdout = "";
  private stderr = "";
  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.done = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.stdout!.on("data", chunk => { this.stdout += chunk; if (this.stdout.length > 8_000_000) this.signal("SIGKILL"); });
      this.child.stderr!.on("data", chunk => { this.stderr += chunk; if (this.stderr.length > 8_000_000) this.signal("SIGKILL"); });
      this.child.once("close", (code, signal) => {
        this.result = { code, signal, stdout: this.stdout, stderr: this.stderr };
        resolve(this.result);
      });
    });
  }
  signal(signal: NodeJS.Signals) {
    if (this.result || !this.child.pid) return;
    // Only the group created by this exact detached spawn. No caller-supplied PID.
    try { process.kill(-this.child.pid, signal); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  async wait(timeoutMs: number) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([this.done, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned process deadline exceeded.")), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  async stop(graceMs = 10000) {
    try { this.signal("SIGTERM"); } catch (error) {
      // macOS may reject a group signal during final process teardown. Only an observed
      // child close can establish that this was an exit race, never the signal error itself.
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      try { return await this.wait(250); } catch { throw error; }
    }
    try { return await this.wait(graceMs); } catch {
      this.signal("SIGKILL");
      return this.wait(5000);
    }
  }
  output() { return { stdout: this.stdout, stderr: this.stderr }; }
  groupAlive() {
    if (!this.child.pid) return false;
    try { process.kill(-this.child.pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  }
}

/** An OS-enforced macOS profile, inherited by child processes. No silent fallback. */
export class LocalRuntime {
  readonly root: string;
  readonly profilePath: string;
  readonly profileSha256: string;
  readonly processes: OwnedProcess[] = [];
  private executors: OwnedProcess[] = [];
  private verified = false;
  private restartEnabled = true;
  constructor(root: string, readonly ports: number[]) {
    if (process.platform !== "darwin") throw new Error("This runtime requires macOS sandbox-exec. No unsandboxed fallback.");
    this.root = realpathSync(root);
    this.profilePath = path.join(this.root, "runtime.sb");
    const profile = networkProfile(ports);
    this.profileSha256 = sha256(profile);
    writeFileSync(this.profilePath, profile, { flag: "wx", mode: 0o600 });
    for (const directory of ["home", "temp", "storage"]) mkdirSync(path.join(this.root, directory), { recursive: true, mode: 0o700 });
  }
  environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const permitted = new Set(["DATABASE_URL", "WORKER_POLL_INTERVAL_MS", "WORKER_HEARTBEAT_INTERVAL_MS", "SERMON_CLIPPER_COMMIT_SHA", "REHEARSAL_CONTROL", "REHEARSAL_MODE", "REHEARSAL_PORT", "PGOPTIONS"]);
    if (Object.keys(extra).some(key => !permitted.has(key))) throw new Error("Runtime environment override refused.");
    if (extra.DATABASE_URL) {
      const url = new URL(extra.DATABASE_URL);
      assertFixtureDatabaseUrl(extra.DATABASE_URL, url.pathname.slice(1));
      if (!this.ports.includes(Number(url.port))) throw new Error("Database port is not owned by this runtime.");
    }
    if (extra.REHEARSAL_CONTROL && !path.resolve(extra.REHEARSAL_CONTROL).startsWith(this.root + path.sep)) throw new Error("Control path is not owned.");
    return {
      NODE_ENV: "test", LC_ALL: "C", LANG: "C", TZ: "UTC", PATH: "/usr/bin:/bin:/usr/local/bin", HOME: path.join(this.root, "home"),
      TMPDIR: path.join(this.root, "temp"), STORAGE_PROVIDER: "local", STORAGE_LOCAL_ROOT: path.join(this.root, "storage"),
      AUTOMATIC_PUBLISHING_ENABLED: "false", AUTOMATIC_SCHEDULE_ARMING_ENABLED: "false",
      NEXT_TELEMETRY_DISABLED: "1", CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", ...extra,
    };
  }
  private launch(command: string, args: string[], extra: Record<string, string>, cwd: string) {
    const owned = new OwnedProcess("/usr/bin/sandbox-exec", ["-f", this.profilePath, command, ...args], cwd, this.environment(extra));
    this.processes.push(owned);
    return owned;
  }
  async verifyNetwork() {
    // Documentation-only TEST-NET address. Require OS denial, never accept a timeout as proof.
    const probe = `const net=require('node:net');const s=net.connect({host:'192.0.2.1',port:9});s.setTimeout(1000,()=>{s.destroy();process.exit(2)});s.on('connect',()=>process.exit(3));s.on('error',e=>{console.log(e.code);process.exit(['EPERM','EACCES'].includes(e.code)?0:4)});`;
    const result = await this.launch(process.execPath, ["-e", probe], {}, this.root).wait(5000);
    if (result.code !== 0 || !/EPERM|EACCES/.test(result.stdout)) throw new Error("OS network denial was not proved.");
    const inherited = `const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,['-e',${JSON.stringify(probe)}],{encoding:'utf8'});process.stdout.write(r.stdout||'');process.exit(r.status??5);`;
    const childResult = await this.launch(process.execPath, ["-e", inherited], {}, this.root).wait(5000);
    if (childResult.code !== 0 || !/EPERM|EACCES/.test(childResult.stdout)) throw new Error("Child process network denial was not proved.");
    const localDenied = await this.launch(process.execPath, ["-e", probe.replace("192.0.2.1", "127.0.0.1")], {}, this.root).wait(5000);
    if (localDenied.code !== 0 || !/EPERM|EACCES/.test(localDenied.stdout)) throw new Error("Unlisted local port denial was not proved.");
    this.verified = true;
    return { direct: result, inherited: childResult, unlistedLocalPort: localDenied, profileSha256: this.profileSha256 };
  }
  start(command: string, args: string[], extra: Record<string, string> = {}, cwd = this.root) {
    if (!this.verified) throw new Error("Verify OS network denial before startup.");
    if (!this.restartEnabled) throw new Error("Fixture restart is disabled.");
    if (!path.isAbsolute(command)) throw new Error("Executable must use an absolute path.");
    const resolved = realpathSync(cwd);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) throw new Error("Working directory is not owned.");
    return this.launch(command, args, extra, resolved);
  }
  async run(command: string, args: string[], extra: Record<string, string> = {}, timeoutMs = 60000, cwd = this.root) {
    const child = this.start(command, args, extra, cwd);
    try {
      const result = await child.wait(timeoutMs);
      if (result.code !== 0) throw new Error(`Fixture command failed: ${path.basename(command)}\n${result.stderr.slice(-4000)}`);
      return result;
    } catch (error) {
      await child.stop(100);
      throw new Error(`${error instanceof Error ? error.message : "Fixture failure"}\nCommand: ${path.basename(command)}\n${child.output().stderr.slice(-4000)}`);
    }
  }
  startExecutor(command: string, args: string[], extra: Record<string, string>, cwd: string) {
    const child = this.start(command, args, extra, cwd);
    this.executors.push(child);
    return child;
  }
  assertExecutorsStopped() {
    if (this.executors.some(child => !child.result || child.groupAlive())) throw new Error("Executors remain active; migration is refused.");
  }
  disableRestart() { this.restartEnabled = false; }
  async stopAll() { for (const child of [...this.processes].reverse()) if (!child.result) await child.stop(); }
}
