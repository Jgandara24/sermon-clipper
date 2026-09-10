import { createHash } from "node:crypto";

export const REHEARSAL_REFS = {
  baseline: "1d77d399a10ab70591974c3a8b4dc110a34e4109",
  candidate: "65aab9e77e460777b0600657edfdad65ca940d1d",
} as const;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Sort object keys only. Array order, IDs, word edits and timestamps remain evidence. */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid evidence number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function databaseNames(runId: string) {
  if (!/^[a-f0-9]{32}$/.test(runId)) throw new Error("Invalid rehearsal identity.");
  return {
    baseline: `p2_rehearsal_${runId}`,
    restore: `p2_restore_${runId}`,
    rollback: `p2_rollback_${runId}`,
  };
}

/** Pure validation. No DNS lookup, socket, database client or environment fallback. */
export function assertFixtureDatabaseUrl(raw: string, expectedName: string): string {
  const refuse = () => { throw new Error("Use the exact generated database on literal loopback with schema=public."); };
  if (!/^p2_(rehearsal|restore|rollback)_[a-f0-9]{32}$/.test(expectedName)) return refuse();
  let url: URL;
  try { url = new URL(raw); } catch { return refuse(); }
  // Require canonical spelling. URL parsing otherwise normalizes misleading input.
  if (raw !== url.href || !["postgresql:", "postgres:"].includes(url.protocol) ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port ||
      Number(url.port) < 1 || Number(url.port) > 65535 ||
      url.username !== "p2_fixture" || url.password !== "" ||
      url.pathname !== `/${expectedName}` || url.search !== "?schema=public" || url.hash) return refuse();
  return url.href;
}

/** Proposed runtime environment, not a network sandbox or authorization to launch. */
export function fixtureEnvironment(databaseUrl: string, expectedName: string, ownedRoot: string) {
  if (!ownedRoot.startsWith("/") || ownedRoot.includes("\n")) throw new Error("Invalid owned root.");
  return Object.freeze({
    NODE_ENV: "test",
    DATABASE_URL: assertFixtureDatabaseUrl(databaseUrl, expectedName),
    HOME: `${ownedRoot}/home`,
    TMPDIR: `${ownedRoot}/temp`,
    STORAGE_PROVIDER: "local",
    STORAGE_LOCAL_ROOT: `${ownedRoot}/storage`,
    AUTOMATIC_PUBLISHING_ENABLED: "false",
    AUTOMATIC_SCHEDULE_ARMING_ENABLED: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    CHECKPOINT_DISABLE: "1",
    PRISMA_HIDE_UPDATE_MESSAGE: "1",
    REHEARSAL_EXECUTION: "disabled",
  });
}

/** A preflight input check only; Stage B still requires OS-level egress denial. */
export function assertLoopbackEndpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid fixture endpoint."); }
  if (url.href !== raw || url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use an explicit literal-loopback fixture endpoint.");
  }
  return url.href;
}

export const EXECUTION_BLOCKERS = [
  "Stage B execution is not authorized by Stage A.",
  "OS network denial and a harmless denial probe have not been verified.",
  "Pinned web/worker fixture injection and matching Prisma builds have not been prepared.",
  "Actual process exit, process-group ownership and restart prevention have not been verified.",
] as const;

/** Stage A cannot be changed into execution by an environment variable or CLI switch. */
export function refuseExecution(): never {
  throw new Error(EXECUTION_BLOCKERS.join(" "));
}

/** Specification records, not database rows. The future seed adapter must map them explicitly. */
export function fixtureSpecification(): Json {
  const id = (family: number, record: number) => `00000000-0000-4000-8000-${String(family * 100 + record).padStart(12, "0")}`;
  return {
    format: 1,
    syntheticOnly: true,
    sourceDate: "2026-05-20",
    serviceOccurrence: "UNRESOLVED — never inferred from source date",
    media: { kind: "fixed-bytes", utf8: "P2 REHEARSAL SYNTHETIC BYTES\n", playable: false },
    families: [1, 2].map(family => ({
      kind: family === 1 ? "untouched" : "human-edited",
      sourceId: id(family, 1), projectId: id(family, 2), transcriptId: id(family, 3),
      segmentId: id(family, 4), clipId: id(family, 5), sourceRevision: 0,
      storageKey: `fixture/${id(family, 1)}.bin`,
      words: ["Synthetic", "caption", "words."].map((text, index) => ({
        wordId: `${id(family, 4)}:${index}`, text, startMs: index * 1000, endMs: (index + 1) * 1000,
      })),
      editVersion: family === 1 ? 1 : 2,
      textOverrides: family === 1 ? [] : [{ wordId: `${id(family, 4)}:0`, text: "Corrected" }],
      export: { id: id(family, 6), key: `fixture/${id(family, 6)}.bin`, checksum: sha256("synthetic-export") },
      approval: family === 1 ? null : { kind: "synthetic-only", clipId: id(family, 5), editVersion: 2 },
      review: family === 1 ? null : { id: id(family, 7), decision: "revise", exportId: id(family, 6) },
      jobs: ["in-flight", "queued-successor", "waiting-retry"].map((role, index) => ({
        id: id(family, 10 + index), role, attempt: index === 2 ? 1 : 0,
      })),
    })),
    executorCases: ["idle-worker", "blocked-worker", "queued-successor", "waiting-retry", "web-inline-callback"],
    providerContract: { output: "deterministic fixture records", claims: "record in order", release: "explicit controller event" },
    forbiddenEffects: ["publication", "schedule arming", "source deletion", "notifications", "paid provider calls"],
  };
}

/** Deterministic provider stand-in. No I/O. This does not exercise a real runner. */
export class FixtureStub {
  readonly events: { action: "claim" | "release"; jobId: string }[] = [];
  private pending = new Map<string, (value: string) => void>();
  claim(jobId: string): Promise<string> {
    if (this.events.some(event => event.action === "claim" && event.jobId === jobId)) throw new Error("Duplicate fixture claim.");
    this.events.push({ action: "claim", jobId });
    return new Promise(resolve => { this.pending.set(jobId, resolve); });
  }
  release(jobId: string) {
    const resolve = this.pending.get(jobId);
    if (!resolve) throw new Error("No pending fixture claim.");
    this.events.push({ action: "release", jobId });
    this.pending.delete(jobId);
    resolve(`synthetic-result:${jobId}`);
  }
}

/** Controller model for later process wiring. It never sends signals or starts processes. */
export class ShutdownGate {
  private intakeOpen = true;
  private restartEnabled = true;
  private alive = new Set<string>();
  private registered = 0;
  private lastActivity = 0;
  constructor(private readonly pollMs: number) {
    if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw new Error("Invalid polling interval.");
  }
  register(executor: string) {
    if (!this.restartEnabled || this.alive.has(executor)) throw new Error("Executor start refused.");
    this.alive.add(executor);
    this.registered += 1;
  }
  closeIntakeAndDisableRestart() { this.intakeOpen = false; this.restartEnabled = false; }
  assertIntakeAllowed() { if (!this.intakeOpen) throw new Error("Fixture intake is closed."); }
  recordClaim(executor: string, now: number) {
    if (!this.alive.has(executor)) throw new Error("Unowned executor.");
    this.recordActivity(now); // A signal does not stop the current loop immediately.
  }
  recordExit(executor: string, now: number) {
    if (!this.alive.has(executor)) throw new Error("Unowned executor.");
    this.recordActivity(now);
    this.alive.delete(executor);
  }
  private recordActivity(now: number) {
    if (!Number.isSafeInteger(now) || now < this.lastActivity) throw new Error("Invalid observation clock.");
    this.lastActivity = now;
  }
  assertMigrationAllowed(now: number) {
    if (!Number.isSafeInteger(now) || !this.registered || this.intakeOpen || this.restartEnabled || this.alive.size || now - this.lastActivity < 2 * this.pollMs) {
      throw new Error("Migration requires stopped executors and two quiet polling intervals.");
    }
  }
}
