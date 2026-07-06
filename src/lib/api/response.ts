export function apiData<T>(data: T, init?: ResponseInit) {
  return Response.json({ data }, init);
}

export function apiError(
  code: string,
  message: string,
  options?: { status?: number; retryable?: boolean },
) {
  return Response.json(
    { error: { code, message, retryable: options?.retryable ?? false } },
    { status: options?.status ?? 400 },
  );
}
