import { env } from "@/lib/env";

/**
 * Minimal Meta Graph API client for Tier 3 Facebook auto-posting (docs/BUSINESS_OVERVIEW.md).
 *
 * Uses a Business Manager System User token (META_SYSTEM_USER_TOKEN) to resolve a Page's own
 * access token, then schedules an unpublished video post on that Page — the same request shape
 * Pulpit Engine already proved live in production once (DECISIONS.md, "Sermon Clipper's Tier 3
 * Facebook Auto-Posting Will Reuse Pulpit Engine's Meta App/Business Manager"):
 *   GET  https://graph.facebook.com/{version}/{pageId}?fields=access_token
 *   POST https://graph-video.facebook.com/{version}/{pageId}/videos
 *        file_url, description, published=false, scheduled_publish_time=<unix seconds>
 *
 * Plain `fetch`, no SDK dependency; both calls accept an injectable fetch so tests never make a
 * real network call (same trust boundary as youtube.ts).
 *
 * Secrets discipline: the token is sent as a query param / bearer header but must never appear
 * in thrown error messages or logs — errors here are built from response status/reason only.
 */

const GRAPH_API_BASE = "https://graph.facebook.com";
const GRAPH_VIDEO_API_BASE = "https://graph-video.facebook.com";

/** META_SYSTEM_USER_TOKEN is not configured — the caller must fail closed, not silently no-op. */
export class FacebookNotConfiguredError extends Error {}

/** 401/403 from the API: invalid/expired/revoked token, or missing permission scope. */
export class FacebookApiAuthError extends Error {}

/** Network failure or an unexpected/unparseable API response. */
export class FacebookApiError extends Error {}

type FetchLike = (url: string, init?: { method?: string; body?: string }) => Promise<
  Pick<Response, "ok" | "status" | "json">
>;

function requireSystemUserToken(): string {
  const token = env.META_SYSTEM_USER_TOKEN;
  if (!token) {
    throw new FacebookNotConfiguredError(
      "META_SYSTEM_USER_TOKEN is not configured. Facebook auto-posting cannot run.",
    );
  }
  return token;
}

async function extractErrorReason(
  response: Awaited<ReturnType<FetchLike>>,
): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { message?: string; type?: string } };
    return body.error?.message ?? body.error?.type ?? null;
  } catch {
    return null;
  }
}

async function requestJson(fetchFn: FetchLike, url: string, init?: { method?: string; body?: string }) {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(url, init);
  } catch {
    throw new FacebookApiError("Could not reach the Facebook Graph API (network failure).");
  }

  if (response.status === 401 || response.status === 403) {
    const reason = await extractErrorReason(response);
    throw new FacebookApiAuthError(
      `Facebook API rejected the request (HTTP ${response.status}${reason ? `, ${reason}` : ""}). ` +
        "The system user token may be invalid, expired, or missing the required permission.",
    );
  }
  if (!response.ok) {
    const reason = await extractErrorReason(response);
    throw new FacebookApiError(
      `Facebook API request failed (HTTP ${response.status}${reason ? `, ${reason}` : ""}).`,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new FacebookApiError("Facebook API returned a response that was not valid JSON.");
  }
}

/** Resolves a Page's own access token via the Business Manager System User token. */
export async function resolvePageAccessToken(
  pageId: string,
  fetchFn: FetchLike = fetch,
): Promise<string> {
  const systemUserToken = requireSystemUserToken();
  const params = new URLSearchParams({ fields: "access_token", access_token: systemUserToken });
  const url = `${GRAPH_API_BASE}/${env.META_GRAPH_API_VERSION}/${pageId}?${params.toString()}`;

  const json = (await requestJson(fetchFn, url)) as { access_token?: string };
  if (!json.access_token) {
    throw new FacebookApiError("Facebook API did not return a page access token.");
  }
  return json.access_token;
}

export type PublishScheduledVideoInput = {
  pageId: string;
  pageAccessToken: string;
  fileUrl: string;
  caption: string;
  /**
   * When the post should go live, as a JS Date — converted to Meta's required unix seconds.
   * Omitted = publish immediately. Meta rejects scheduled_publish_time values that are in the
   * past or less than ~10 minutes out, so callers must omit this (not send a past instant)
   * when the target time is already here.
   */
  scheduledPublishAt?: Date;
};

/** Creates a video post on the Page — scheduled when scheduledPublishAt is set, live otherwise. */
export async function publishScheduledVideo(
  input: PublishScheduledVideoInput,
  fetchFn: FetchLike = fetch,
): Promise<{ facebookPostId: string }> {
  const url = `${GRAPH_VIDEO_API_BASE}/${env.META_GRAPH_API_VERSION}/${input.pageId}/videos`;
  const body = new URLSearchParams({
    file_url: input.fileUrl,
    description: input.caption,
    access_token: input.pageAccessToken,
  });
  if (input.scheduledPublishAt) {
    body.set("published", "false");
    body.set("scheduled_publish_time", String(Math.floor(input.scheduledPublishAt.getTime() / 1000)));
  }

  const json = (await requestJson(fetchFn, url, { method: "POST", body: body.toString() })) as {
    id?: string;
  };
  if (!json.id) {
    throw new FacebookApiError("Facebook API did not return a post id for the scheduled video.");
  }
  return { facebookPostId: json.id };
}
