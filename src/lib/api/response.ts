export function apiData<T>(data: T, init?: ResponseInit) {
  return Response.json({ data }, init);
}

export function apiError(
  code: string,
  message: string,
  options?: { status?: number; retryable?: boolean },
) {
  const status = options?.status ?? 400;

  if (status >= 500) {
    // Handled 5xx responses would otherwise be invisible to Sentry — only uncaught exceptions
    // reach the instrumentation.ts hook. No-op when SENTRY_DSN is unset.
    void import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.captureMessage(`API ${status} ${code}: ${message}`, "error");
      })
      .catch(() => {});
  }

  return Response.json(
    { error: { code, message, retryable: options?.retryable ?? false } },
    { status },
  );
}
