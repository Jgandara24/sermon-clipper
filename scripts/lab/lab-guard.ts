/**
 * Shared safety checks for the Phase 1 lab scripts (docs/PHASE1_LAB_PLAN.md).
 *
 * The lab runs on Jake's Mac against one disposable database. Every lab script refuses to start
 * unless it can prove it is pointed there, so a copied command can never reach production.
 */

export const LAB_DEMO_EMAIL = "demo@sermonclipper.local";
export const LAB_WORKSPACE_NAME = "First Baptist Demo";
export const LAB_DATABASE_NAME = "pulpit_engine_lab";

export class LabEnvironmentError extends Error {}

export function assertLabEnvironment(opts: { requireAnthropicKey: boolean }): void {
  if (process.env.NODE_ENV === "production") {
    throw new LabEnvironmentError("Lab scripts never run with NODE_ENV=production.");
  }

  const databaseUrl = process.env.DATABASE_URL ?? "";
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(databaseUrl);
  const isLabDatabase = new RegExp(`/${LAB_DATABASE_NAME}(\\?|$)`).test(databaseUrl);
  if (!isLocal || !isLabDatabase) {
    throw new LabEnvironmentError(
      `Lab scripts only run against the local database "${LAB_DATABASE_NAME}". ` +
        "DATABASE_URL points somewhere else. Nothing was changed.",
    );
  }

  for (const flag of [
    "AUTOMATIC_PUBLISHING_ENABLED",
    "AUTOMATIC_SCHEDULE_ARMING_ENABLED",
    "SOURCE_RETENTION_DELETION_ENABLED",
  ]) {
    if (process.env[flag] === "true") {
      throw new LabEnvironmentError(`${flag} must stay off in the lab. Nothing was changed.`);
    }
  }

  if ((process.env.STORAGE_PROVIDER ?? "local") !== "local") {
    throw new LabEnvironmentError("The lab uses STORAGE_PROVIDER=local only. Nothing was changed.");
  }

  if (opts.requireAnthropicKey && !process.env.ANTHROPIC_API_KEY) {
    throw new LabEnvironmentError(
      "ANTHROPIC_API_KEY is missing from .env. Without it the picker silently uses a dumb " +
        "fallback outside production. Add the key to .env, then run again.",
    );
  }
}

/** `--name value` and `--flag` parsing, enough for the lab scripts. */
export function readArgs(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(key, next);
      i += 1;
    } else {
      out.set(key, true);
    }
  }
  return out;
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
