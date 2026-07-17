import type { Instrumentation } from "next";

/**
 * Next.js server instrumentation (web process only; the worker wires Sentry through
 * src/lib/observability/error-reporting.ts). Gated on SENTRY_DSN: unset — local dev, CI — means
 * nothing initializes and no events leave the machine.
 */

function sentryEnabled() {
  return Boolean(process.env.SENTRY_DSN) && process.env.NEXT_RUNTIME === "nodejs";
}

export async function register() {
  if (!sentryEnabled()) {
    return;
  }
  const Sentry = await import("@sentry/nextjs");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.SERMON_CLIPPER_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA,
    // Errors only — tracing volume isn't worth the cost at this stage.
    tracesSampleRate: 0,
  });
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (!sentryEnabled()) {
    return;
  }
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(err, request, context);
};
