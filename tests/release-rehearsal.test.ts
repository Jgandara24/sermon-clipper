import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFixtureDatabaseUrl, assertLoopbackEndpoint, canonicalJson, databaseNames, fixtureEnvironment, fixtureSpecification, FixtureStub, refuseExecution, sha256, ShutdownGate } from "../scripts/lib/release-rehearsal";
import { allowedExportPath, exportRevision, parseExportTree } from "../scripts/lib/release-rehearsal-files";

const name = databaseNames("a".repeat(32)).baseline;
const valid = `postgresql://p2_fixture@127.0.0.1:5432/${name}?schema=public`;
const ownedDirectories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of ownedDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("rehearsal environment refusal, without connections", () => {
  it.each([valid, valid.replace("127.0.0.1", "[::1]")])("accepts literal loopback and the exact generated identity", value => {
    expect(assertFixtureDatabaseUrl(value, name)).toBe(value);
  });
  it.each([
    valid.replace("127.0.0.1", "production.invalid"), valid.replace("127.0.0.1", "localhost"),
    valid.replace("127.0.0.1", "127.1"), valid.replace("127.0.0.1", "2130706433"),
    valid.replace("127.0.0.1", "127.0.0.1.evil.invalid"), valid.replace("127.0.0.1", "[::ffff:127.0.0.1]"),
    valid.replace(name, "existing_database"), valid.replace(name, databaseNames("b".repeat(32)).baseline),
    valid.replace("p2_fixture@", "p2_fixture:secret-canary@"), valid.replace("p2_fixture", "admin"),
    valid.replace(":5432", ""), valid.replace(":5432", ":0"),
    `${valid}&host=production.invalid`, `${valid}&schema=public`, `${valid}&options=secret-canary`,
    valid.replace("schema=public", "schema=private"), valid.replace("schema=public", "schema=%70ublic"),
    `${valid}#secret-canary`, ` ${valid}`, "secret-canary", valid.replace("postgresql:", "https:"),
  ])("refuses an unsafe database address without echoing it", value => {
    expect(() => assertFixtureDatabaseUrl(value, name)).toThrow("literal loopback");
    try { assertFixtureDatabaseUrl(value, name); } catch (error) { expect(String(error)).not.toContain("secret-canary"); }
  });
  it("does not inherit credentials, loaders, proxies or endpoint overrides", () => {
    for (const key of ["DATABASE_URL", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "STORAGE_S3_ENDPOINT", "NODE_OPTIONS", "HTTP_PROXY", "PGHOST", "ELEVENLABS_API_KEY", "HOME"]) {
      vi.stubEnv(key, "secret-canary");
    }
    const env = fixtureEnvironment(valid, name, "/owned/fixture");
    expect(JSON.stringify(env)).not.toContain("secret-canary");
    expect(env.DATABASE_URL).toBe(valid);
    expect(env.AUTOMATIC_PUBLISHING_ENABLED).toBe("false");
    expect(env.AUTOMATIC_SCHEDULE_ARMING_ENABLED).toBe("false");
    expect(env.REHEARSAL_EXECUTION).toBe("disabled");
    expect(env).not.toHaveProperty("PATH");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
  });
  it.each(["http://remote.invalid:8000/", "http://localhost:8000/", "http://127.1:8000/", "https://127.0.0.1:8000/", "http://127.0.0.1:8000/?host=remote.invalid", "http://user:secret@127.0.0.1:8000/"])("refuses forbidden provider destinations before startup", value => {
    expect(() => assertLoopbackEndpoint(value)).toThrow();
  });
  it("accepts only explicit local stub endpoints and still refuses execution", () => {
    expect(assertLoopbackEndpoint("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000/");
    vi.stubEnv("REHEARSAL_EXECUTION", "enabled");
    expect(refuseExecution).toThrow("OS network denial");
  });
});

describe("source export and evidence", () => {
  it("retains media helper source code while excluding recording files", () => {
    expect(allowedExportPath("src/lib/media/probe.ts")).toBe(true);
    expect(allowedExportPath("src/lib/media/recording.mp4")).toBe(false);
  });
  it.each([".env", ".env.example", "src/.env.ts", "src/../outside.ts", "/src/a.ts", "src/a\\b.ts", "src/credentials/key.ts", "public/sermon.mp4", "prisma/media/recording.sql", "docs/P2_SANDBOX_TEST_PLAN.md"])("excludes private or non-build path %s", value => {
    expect(allowedExportPath(value)).toBe(false);
  });
  it("refuses a symlink blob before export", () => {
    expect(() => parseExportTree(`120000 blob ${"a".repeat(40)}\tsrc/link.ts\0`)).toThrow("links");
  });
  it("exports committed bytes only and records matching hashes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "p2-export-test-"));
    ownedDirectories.push(root);
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    const git = (args: string[]) => execFileSync("/usr/bin/git", ["-C", repo, ...args], {
      encoding: "utf8", env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trim();
    git(["init", "--quiet"]);
    for (const file of ["package-lock.json", "prisma/schema.prisma", "src/worker/run-jobs.ts", "src/app/actions/projects.ts", ".env", "public/sermon.mp4"]) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), file === ".env" ? "secret-canary" : "committed fixture");
    }
    git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
    const commit = git(["rev-parse", "HEAD"]);
    writeFileSync(path.join(repo, "src/worker/run-jobs.ts"), "uncommitted-canary");
    writeFileSync(path.join(repo, "src/untracked.ts"), "untracked-canary");
    const output = path.join(root, "export");
    const manifest = exportRevision(repo, output, commit);
    expect(readFileSync(path.join(output, "src/worker/run-jobs.ts"), "utf8")).toBe("committed fixture");
    expect(manifest.runnerSha256).toBe(sha256("committed fixture"));
    for (const excluded of [".env", "public/sermon.mp4", "src/untracked.ts"]) expect(existsSync(path.join(output, excluded))).toBe(false);
    expect(() => exportRevision(repo, output, commit)).toThrow(); // No overwrite.
    symlinkSync("/outside", path.join(repo, "src/link.ts"));
    git(["add", "src/link.ts"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "link fixture"]);
    expect(() => exportRevision(repo, path.join(root, "linked"), git(["rev-parse", "HEAD"]))).toThrow("links");
  });
  it("canonicalizes key order without hiding edit or word identity changes", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    const fixture = fixtureSpecification();
    const original = canonicalJson(fixture);
    expect(original).toContain("Corrected");
    expect(sha256(original.replace("Corrected", "Changed"))).not.toBe(sha256(original));
    expect(sha256(original.replace(":0", ":9"))).not.toBe(sha256(original));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });
});

describe("shutdown controller model and stub, not real process evidence", () => {
  it("blocks migration while a web callback remains alive", () => {
    const gate = new ShutdownGate(100);
    gate.register("worker"); gate.register("web");
    gate.closeIntakeAndDisableRestart();
    expect(() => gate.assertIntakeAllowed()).toThrow("closed");
    expect(() => gate.register("restart")).toThrow("refused");
    gate.recordExit("worker", 10);
    expect(() => gate.assertMigrationAllowed(1000)).toThrow();
    gate.recordClaim("web", 1100);
    gate.recordExit("web", 1200);
    expect(() => gate.assertMigrationAllowed(1399)).toThrow();
    expect(() => gate.assertMigrationAllowed(1400)).not.toThrow();
  });
  it("rejects empty observations, unowned exits and backwards clocks", () => {
    const gate = new ShutdownGate(100);
    gate.closeIntakeAndDisableRestart();
    expect(() => gate.assertMigrationAllowed(1000)).toThrow();
    expect(() => gate.recordExit("unowned", 1000)).toThrow();
    const active = new ShutdownGate(100);
    active.register("worker"); active.recordClaim("worker", 100);
    expect(() => active.recordExit("worker", 99)).toThrow();
  });
  it("blocks a fixture claim until explicit release and records exact order", async () => {
    const stub = new FixtureStub();
    const result = stub.claim("job-1");
    let finished = false;
    void result.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(() => stub.claim("job-1")).toThrow("Duplicate");
    expect(() => stub.release("unknown")).toThrow();
    stub.release("job-1");
    await expect(result).resolves.toBe("synthetic-result:job-1");
    expect(stub.events).toEqual([{ action: "claim", jobId: "job-1" }, { action: "release", jobId: "job-1" }]);
  });
});

describe("Stage A CLI", () => {
  it.each([["--run"], ["--prepare", "--apply"], ["--database-url", "secret-canary"], []])("refuses execution and unknown input", (...args) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/prepare-release-rehearsal.ts", ...args], {
      encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, NODE_ENV: "test" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("secret-canary");
    expect(result.stderr).toContain("refuses all execution");
  }, 15000);
});
