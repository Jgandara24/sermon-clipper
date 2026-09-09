import { env } from "@/lib/env";

/**
 * The publisher's existing local URL check. This does not test DNS, reachability,
 * authentication, or whether Meta can download a file from this address.
 */
export function resolvePublicAppUrl(): string | null {
  const appUrl = env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appUrl) return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(appUrl)) return null;
  return appUrl;
}
