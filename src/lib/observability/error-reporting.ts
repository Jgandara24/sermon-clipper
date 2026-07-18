/**
 * DSN-gated error reporting for the standalone worker process (the web app wires Sentry through
 * src/instrumentation.ts instead). When SENTRY_DSN is unset — local dev, CI — every function here
 * is a no-op, so no Sentry code loads and nothing leaves the machine.
 */

import { env } from "@/lib/env";

type SentryNodeModule = typeof import("@sentry/node");

let sentryPromise: Promise<SentryNodeModule | null> | null = null;

function loadSentry(): Promise<SentryNodeModule | null> {
  if (!env.SENTRY_DSN) {
    return Promise.resolve(null);
  }
  if (!sentryPromise) {
    sentryPromise = import("@sentry/node")
      .then((sentry) => {
        sentry.init({
          dsn: env.SENTRY_DSN,
          environment: process.env.NODE_ENV ?? "development",
          release: env.SERMON_CLIPPER_COMMIT_SHA || env.RAILWAY_GIT_COMMIT_SHA,
          // Errors only — tracing volume isn't worth the cost at this stage.
          tracesSampleRate: 0,
        });
        return sentry;
      })
      .catch((error) => {
        console.error("[observability] failed to initialize Sentry", error);
        return null;
      });
  }
  return sentryPromise;
}

/** Initializes Sentry at worker startup when SENTRY_DSN is set; no-op otherwise. */
export async function initErrorReporting(context?: Record<string, string>) {
  const sentry = await loadSentry();
  if (sentry && context) {
    sentry.setTags(context);
  }
}

/** Reports an error with context. Never throws — telemetry must not break the worker. */
export async function captureErrorSafely(error: unknown, context?: Record<string, unknown>) {
  try {
    const sentry = await loadSentry();
    if (!sentry) {
      return;
    }
    sentry.captureException(error, context ? { extra: context } : undefined);
  } catch (reportingError) {
    console.error("[observability] failed to report error", reportingError);
  }
}

/** Flushes pending events before process exit; no-op without a DSN. */
export async function flushErrorReporting(timeoutMs = 2000) {
  try {
    const sentry = await loadSentry();
    await sentry?.flush(timeoutMs);
  } catch {
    // Losing a final event on shutdown is acceptable; hanging the shutdown is not.
  }
}
