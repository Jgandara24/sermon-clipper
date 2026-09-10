import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, databaseNames, EXECUTION_BLOCKERS, fixtureEnvironment, fixtureSpecification, REHEARSAL_REFS, sha256, type Json } from "./release-rehearsal";

const rootFiles = new Set([
  "package.json", "package-lock.json", "tsconfig.json", "tsconfig.worker.json",
  "next.config.ts", "postcss.config.mjs", "eslint.config.mjs", "Dockerfile.worker",
]);

export function allowedExportPath(file: string): boolean {
  const parts = file.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.startsWith(".") ||
    /^(node_modules|uploads|credentials|secrets)$/i.test(part) ||
    (part.toLowerCase() === "media" && !file.startsWith("src/lib/media/"))) || /[\x00-\x1f\\]/.test(file)) return false;
  if (rootFiles.has(file)) return true;
  return /^(src|scripts|prisma)\//.test(file) && /\.(ts|tsx|js|mjs|cjs|prisma|sql|toml|sh)$/.test(file);
}

type GitEntry = { mode: string; oid: string; file: string };

export function parseExportTree(tree: string): GitEntry[] {
  return tree.split("\0").filter(Boolean).flatMap(entry => {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error("Invalid Git tree entry.");
    const [, mode, type, oid, file] = match;
    if (!allowedExportPath(file)) return [];
    if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error("Export refuses links and special files.");
    return [{ mode, oid, file }];
  });
}

// No inherited Git config, hooks, loader flags, credential helper or alternate object store.
// Commands read local objects only. No fetch, checkout, install, build or application launch.
function git(repo: string, args: string[], input?: string): Buffer {
  return execFileSync("/usr/bin/git", ["--no-replace-objects", "-C", repo, ...args], {
    input, timeout: 30000, maxBuffer: 64 * 1024 * 1024,
    env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function readPinnedTest(repo: string, name: "source-copy.integration.test.ts" | "source-revision-upgrade.integration.test.ts" | "transcribe-handoff.integration.test.ts") {
  return git(repo, ["show", `${REHEARSAL_REFS.candidate}:tests/integration/${name}`]).toString();
}

export function exportRevision(repo: string, root: string, commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit) || git(repo, ["rev-parse", `${commit}^{commit}`]).toString().trim() !== commit) {
    throw new Error("Pinned commit is not available locally.");
  }
  const entries = parseExportTree(git(repo, ["ls-tree", "-rz", commit]).toString());
  // cat-file reads raw committed blobs, bypassing filters, checkout hooks and the working tree.
  const blobs = git(repo, ["cat-file", "--batch"], entries.map(entry => entry.oid).join("\n") + "\n");
  let offset = 0;
  const files: { path: string; sha256: string; bytes: number; gitMode: string }[] = [];
  for (const entry of entries) {
    const end = blobs.indexOf(10, offset);
    if (end < 0) throw new Error("Incomplete committed blob.");
    const header = blobs.subarray(offset, end).toString().split(" ");
    const size = Number(header[2]);
    if (header[0] !== entry.oid || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0 || end + size + 1 >= blobs.length) {
      throw new Error("Invalid committed blob.");
    }
    const bytes = blobs.subarray(end + 1, end + 1 + size);
    offset = end + size + 2;
    const destination = path.join(root, entry.file);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    // Exported scripts are deliberately not executable. No dependencies are copied.
    writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
    files.push({ path: entry.file, sha256: sha256(bytes), bytes: size, gitMode: entry.mode });
  }
  const required = (name: string) => {
    const file = files.find(item => item.path === name);
    if (!file) throw new Error("Pinned build is missing a required input.");
    return file.sha256;
  };
  return {
    commit, files, lockfileSha256: required("package-lock.json"), schemaSha256: required("prisma/schema.prisma"),
    runnerSha256: required("src/worker/run-jobs.ts"), webCallbackSha256: required("src/app/actions/projects.ts"),
    migrations: files.filter(file => /^prisma\/migrations\/[^/]+\/migration.sql$/.test(file.path)),
    prismaClient: "NOT GENERATED — generate independently against this schema in later build preparation",
    instrumentationPatches: [],
  };
}

/** Files only. Uses a fresh OS temporary directory, outside the repository and its typecheck. */
export function prepareRehearsal(repo: string) {
  const runId = randomUUID().replaceAll("-", "");
  const root = mkdtempSync(path.join(tmpdir(), "p2-release-rehearsal-"));
  const save = (name: string, value: Json) => writeFileSync(path.join(root, name), canonicalJson(value) + "\n", { flag: "wx", mode: 0o600 });
  // Preserve failed preparations for inspection; never recursively delete caller-controlled paths.
  save("owner.json", { runId, root, createdAt: new Date().toISOString(), stage: "A", createdDatabases: [], createdBuckets: [], startedProcesses: [] });
  try {
    const revisions = {
      baseline: exportRevision(repo, path.join(root, "baseline"), REHEARSAL_REFS.baseline),
      candidate: exportRevision(repo, path.join(root, "candidate"), REHEARSAL_REFS.candidate),
    };
    if (revisions.baseline.migrations.length !== 26 || revisions.candidate.migrations.length !== 28) {
      throw new Error("Unexpected migration count in pinned builds.");
    }
    const names = databaseNames(runId);
    const fixtures = fixtureSpecification();
    save("fixtures.json", fixtures);
    const environments = Object.fromEntries(Object.entries(names).map(([role, name]) => [role,
      fixtureEnvironment(`postgresql://p2_fixture@127.0.0.1:5432/${name}?schema=public`, name, root),
    ]));
    save("environment-proposals.json", environments);
    const manifest = {
      format: 1, stage: "A", runId, root, createdAt: new Date().toISOString(),
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      revisions, proposedDatabases: names, fixturesSha256: sha256(canonicalJson(fixtures)),
      environmentSha256: sha256(canonicalJson(environments)),
      execution: "DISABLED", blockers: [...EXECUTION_BLOCKERS],
      results: { shutdown: "NOT RUN", migration: "NOT RUN", restore: "NOT RUN", rollback: "NOT RUN", remoteStorage: "NOT RUN" },
      limits: ["No dependencies installed or Prisma clients generated.", "No instrumentation patches applied.", "Fixture records are specifications, not seeded rows.", "Source exports omit media, environments, tests, documentation and deployment settings."],
    };
    save("manifest.json", manifest);
    save("evidence-template.json", {
      runId, pinnedRefs: REHEARSAL_REFS, manifestSha256: sha256(canonicalJson(manifest)),
      cases: ["shutdown", "backup-restore", "migration", "rollback", "storage"].map(name => ({
        name, status: "NOT RUN", startedAt: null, finishedAt: null, expected: null, actual: null,
        snapshotBeforeSha256: null, snapshotAfterSha256: null, redactedLogPath: null, cleanup: "NOT RUN",
      })),
    });
    return { root, runId, baselineFiles: revisions.baseline.files.length, candidateFiles: revisions.candidate.files.length };
  } catch {
    save("failure.json", { status: "FAILED", execution: "DISABLED", reason: "Preparation failed. No execution is permitted." });
    throw new Error(`Rehearsal preparation failed. Inspect local evidence at ${root}.`);
  }
}
