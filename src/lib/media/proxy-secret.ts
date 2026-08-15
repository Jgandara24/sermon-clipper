/**
 * Pure helpers for keeping the yt-dlp proxy URL out of stored text.
 *
 * Node's execFile bakes the whole command line — including `--proxy <url>` with its credentials —
 * into a rejection message, and job-failure metadata is rendered on the church-facing operations
 * page. The runtime path redacts before an error escapes; the audit path uses the same tokens to
 * find text that leaked before that guard existed.
 */

/** The generic marker: its presence means a command line reached stored text at all. */
export const PROXY_ARGUMENT_MARKER = "--proxy";

/** Short strings match unrelated text, so they are never used as search needles. */
const MIN_TOKEN_LENGTH = 4;

export type ProxySecretTokens = {
  /** Userinfo and password strings. A match means the credential itself leaked. */
  credential: string[];
  /** Full URL and host. A match exposes infrastructure but not necessarily the credential. */
  location: string[];
};

/** Splits a proxy URL into the distinct strings that must never appear in stored text. */
export function proxySecretTokens(proxyUrl: string | null | undefined): ProxySecretTokens {
  const credential: string[] = [];
  const location: string[] = [];
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return { credential, location };

  location.push(trimmed);
  try {
    const parsed = new URL(trimmed);
    const username = decodeURIComponent(parsed.username);
    const password = decodeURIComponent(parsed.password);
    if (username && password) credential.push(`${username}:${password}`);
    if (password) credential.push(password);
    if (parsed.host) location.push(parsed.host);
    if (parsed.hostname && parsed.hostname !== parsed.host) location.push(parsed.hostname);
  } catch {
    // Not URL-parseable. The whole-string token above is the only reliable needle.
  }

  const usable = (values: string[]) =>
    [...new Set(values)].filter((value) => value.length >= MIN_TOKEN_LENGTH);
  return { credential: usable(credential), location: usable(location) };
}

/** Every needle worth searching for, longest first so redaction removes the widest match. */
export function proxySecretNeedles(proxyUrl: string | null | undefined): string[] {
  const tokens = proxySecretTokens(proxyUrl);
  return [...tokens.credential, ...tokens.location].sort((a, b) => b.length - a.length);
}

/** Replaces every form of the proxy secret. Safe to call with no configured proxy. */
export function redactProxySecrets(text: string, proxyUrl: string | null | undefined): string {
  if (!text) return text;
  const tokens = proxySecretTokens(proxyUrl);
  let redacted = text;
  for (const value of [...tokens.credential].sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(value).join("[proxy-credentials]");
  }
  for (const value of [...tokens.location].sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(value).join("[proxy-url]");
  }
  return redacted;
}

/** Classifies one stored string by the worst proxy secret it contains. */
export function classifyProxyExposure(
  text: string,
  proxyUrl: string | null | undefined,
): "credential" | "location" | "marker" | "none" {
  const tokens = proxySecretTokens(proxyUrl);
  if (tokens.credential.some((value) => text.includes(value))) return "credential";
  if (tokens.location.some((value) => text.includes(value))) return "location";
  return text.includes(PROXY_ARGUMENT_MARKER) ? "marker" : "none";
}
