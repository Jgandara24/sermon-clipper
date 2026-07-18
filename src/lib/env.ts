import { z } from "zod";

/**
 * Central typed accessor for the environment variables documented in .env.example.
 *
 * Design constraints (do not "improve" these away):
 *
 * - `next build` evaluates modules with no production env vars set, and local dev/CI run with
 *   almost nothing configured. Nothing here validates eagerly at import time — every field is
 *   parsed lazily on property access, and every field is optional or defaulted. Required-in-prod
 *   enforcement stays where it always was: src/lib/deployment/readiness.ts plus the existing
 *   point-of-use guards (e.g. getStripeClient, getSigningSecret).
 * - Tests mutate `process.env` at runtime (some even reassign the whole object), so accessors
 *   re-read `process.env` on every access. No memoization on purpose.
 * - Prefix rules (sk_, whsec_, price_, sk-ant) are intentionally NOT enforced here — a schema
 *   failure would be a new runtime failure that does not exist today. readiness.ts reports them.
 * - Numeric fields preserve the exact historical parsing semantics of their call sites,
 *   including the ones that deliberately have no garbage guard (documented per field).
 */

const optionalString = z.string().optional();

/** `Number(raw ?? fallback)` with no garbage guard — garbage yields NaN, exactly as before. */
const rawNumber = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw) => Number(raw ?? fallback));

/** Finite and > 0, floored to an integer; anything else falls back. */
const positiveInt = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      const value = Number(raw ?? fallback);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
    });

/** Finite and >= 0; anything else falls back. No flooring. */
const nonNegativeNumber = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      const value = Number(raw ?? fallback);
      return Number.isFinite(value) && value >= 0 ? value : fallback;
    });

/** Finite and > 0; anything else falls back. No flooring. */
const positiveNumber = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      const value = Number(raw ?? fallback);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    });

/** `Number(raw ?? fallback) || fallback` — garbage AND zero both fall back. */
const numberOrFallback = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw) => Number(raw ?? fallback) || fallback);

const fieldSchemas = {
  // Core
  DATABASE_URL: optionalString,
  NEXT_PUBLIC_APP_URL: optionalString,
  NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: optionalString,
  SERMON_CLIPPER_COMMIT_SHA: optionalString,
  RAILWAY_GIT_COMMIT_SHA: optionalString,

  // Media URL signing. AUTH_SECRET/NEXTAUTH_SECRET are dev-only fallbacks used by
  // getSigningSecret in src/lib/media/signed-url.ts.
  MEDIA_URL_SECRET: optionalString,
  AUTH_SECRET: optionalString,
  NEXTAUTH_SECRET: optionalString,

  // Storage
  STORAGE_PROVIDER: z.string().default("local"),
  STORAGE_LOCAL_ROOT: optionalString,
  STORAGE_S3_BUCKET: optionalString,
  STORAGE_S3_REGION: z.string().default("auto"),
  STORAGE_S3_ENDPOINT: optionalString,
  STORAGE_S3_ACCESS_KEY_ID: optionalString,
  STORAGE_S3_SECRET_ACCESS_KEY: optionalString,
  STORAGE_S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((raw) => raw === "true"),

  // Email / notifications
  RESEND_API_KEY: optionalString,
  AUTH_EMAIL_FROM: optionalString,
  AUTH_EMAIL_FROM_NAME: optionalString,
  NOTIFICATIONS_FROM_EMAIL: optionalString,
  NOTIFICATIONS_FROM_NAME: optionalString,
  // Historical variable name used only by operational alert emails (distinct from
  // NOTIFICATIONS_FROM_NAME); preserved as-is.
  NOTIFICATIONS_FROM_EMAIL_NAME: optionalString,
  OPERATIONS_ALERT_EMAIL: optionalString,
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_MESSAGING_FROM: optionalString,

  // Stripe (prefix rules enforced by readiness.ts, not here)
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_PRICE_STARTER: optionalString,
  STRIPE_PRICE_PRO: optionalString,

  // Media tooling (call sites apply `|| "ffmpeg"`-style defaults via the helpers below so an
  // empty string still falls back, exactly as before)
  FFMPEG_PATH: optionalString,
  FFPROBE_PATH: optionalString,
  YTDLP_PATH: optionalString,
  WHISPER_CPP_BINARY: optionalString,
  WHISPER_MODEL_PATH: optionalString,

  // AI analysis
  ANTHROPIC_API_KEY: optionalString,
  ANALYSIS_MODEL_CLASSIFY: optionalString,
  ANALYSIS_MODEL_SCORING: optionalString,

  // YouTube Data API v3 (channel auto-import). App-level key, like ANTHROPIC_API_KEY.
  YOUTUBE_API_KEY: optionalString,

  // Observability
  SENTRY_DSN: optionalString,
  ALERTS_THROTTLE_MS: numberOrFallback(30 * 60 * 1000),

  // Rate limits (positive integer or fallback)
  EXPORT_MAX_CONCURRENT_JOBS: positiveInt(4),
  EXPORT_DAILY_JOB_LIMIT: positiveInt(50),
  UPLOAD_PRESIGN_HOURLY_LIMIT: positiveInt(30),
  CHANNEL_IMPORT_DAILY_LIMIT: positiveInt(10),

  // Retention (non-negative or fallback; 0 is a valid "no grace period")
  EXPORT_FILE_RETENTION_GRACE_MS: nonNegativeNumber(30 * 24 * 60 * 60 * 1000),

  // Worker tuning. These intentionally have NO garbage guard (garbage yields NaN), matching the
  // original `Number(process.env.X ?? default)` call sites exactly.
  WORKER_ID: optionalString,
  WORKER_POLL_INTERVAL_MS: rawNumber(2000),
  WORKER_RECOVERY_INTERVAL_MS: rawNumber(60_000),
  WORKER_CLEANUP_INTERVAL_MS: rawNumber(3_600_000),
  WORKER_HEARTBEAT_INTERVAL_MS: rawNumber(30_000),
  WORKER_PROCESS_HEARTBEAT_INTERVAL_MS: rawNumber(30_000),
  WORKER_STALE_JOB_TIMEOUT_MS: rawNumber(15 * 60_000),
  // Channel auto-import polling cadence (worker loop, same timestamp-comparison pattern as
  // WORKER_CLEANUP_INTERVAL_MS). Default 60 minutes.
  CHANNEL_POLL_INTERVAL_MS: rawNumber(60 * 60_000),
} satisfies Record<string, z.ZodType>;

type EnvSchemaMap = typeof fieldSchemas;

export type Env = { readonly [K in keyof EnvSchemaMap]: z.output<EnvSchemaMap[K]> };

function buildEnvAccessor(): Env {
  const accessor = {} as Env;
  for (const key of Object.keys(fieldSchemas) as (keyof EnvSchemaMap)[]) {
    Object.defineProperty(accessor, key, {
      enumerable: true,
      get: () => fieldSchemas[key].parse(process.env[key]),
    });
  }
  return accessor;
}

/**
 * Lazy typed environment accessor. Each property access re-reads `process.env` and runs the
 * value through that field's zod parser. Never throws for absent variables.
 */
export const env: Env = buildEnvAccessor();

// ---------------------------------------------------------------------------
// Fallback chains. Each chain lives here once; call sites must not re-encode them.
// ---------------------------------------------------------------------------

/** Sender for notification emails (invitations): NOTIFICATIONS_FROM_EMAIL ?? AUTH_EMAIL_FROM. */
export function notificationsFromEmail(): string | undefined {
  return env.NOTIFICATIONS_FROM_EMAIL ?? env.AUTH_EMAIL_FROM;
}

/** Sender display name for notification emails. */
export function notificationsFromName(): string {
  return env.NOTIFICATIONS_FROM_NAME ?? env.AUTH_EMAIL_FROM_NAME ?? "Sermon Clipper";
}

/** Sender for auth (OTP) emails — the reverse preference: AUTH_EMAIL_FROM ?? NOTIFICATIONS_FROM_EMAIL. */
export function authEmailFrom(): string | undefined {
  return env.AUTH_EMAIL_FROM ?? env.NOTIFICATIONS_FROM_EMAIL;
}

/** Sender display name for auth (OTP) emails. */
export function authEmailFromName(): string {
  return env.AUTH_EMAIL_FROM_NAME ?? env.NOTIFICATIONS_FROM_NAME ?? "Sermon Clipper";
}

/**
 * Sender for operational alert emails. Historically used `||` (not `??`), so an empty-string
 * NOTIFICATIONS_FROM_EMAIL falls through to AUTH_EMAIL_FROM — preserved exactly.
 */
export function operationsAlertFromEmail(): string | undefined {
  return env.NOTIFICATIONS_FROM_EMAIL || env.AUTH_EMAIL_FROM;
}

// ---------------------------------------------------------------------------
// Binary paths. `||` on purpose: an empty-string override still falls back.
// ---------------------------------------------------------------------------

export function ffmpegPath(): string {
  return env.FFMPEG_PATH || "ffmpeg";
}

export function ffprobePath(): string {
  return env.FFPROBE_PATH || "ffprobe";
}

export function ytDlpPath(): string {
  return env.YTDLP_PATH || "yt-dlp";
}

/**
 * Hard timeout (ms) for a media child process, overridable per-invocation via an env var
 * (e.g. FFPROBE_TIMEOUT_MS). Generic by name because call sites pass their own var name and
 * default. Finite and > 0 or the default wins.
 */
export function envTimeoutMs(envVar: string, defaultMs: number): number {
  return positiveNumber(defaultMs).parse(process.env[envVar]);
}
