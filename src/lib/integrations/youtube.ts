import { env } from "@/lib/env";

/**
 * Minimal YouTube Data API v3 client for channel auto-import.
 *
 * Uses only `channels.list` (1 quota unit) to resolve a channel's uploads playlist and
 * `playlistItems.list` (1 quota unit) for recent uploads — never `search.list` (100 units).
 * Plain `fetch`, no googleapis dependency; both functions accept an injectable fetch so tests
 * never make a real network call (the same trust boundary as the injected exec in ytdlp.ts).
 *
 * Secrets discipline: the API key is appended to request URLs but must never appear in thrown
 * error messages or logs — errors here are built from response status/reason only.
 */

const API_BASE = "https://www.googleapis.com/youtube/v3";

export type YouTubeChannel = {
  channelId: string;
  title: string;
  /** The channel's public handle (e.g. "@churchname"), when YouTube reports one. */
  handle: string | null;
  uploadsPlaylistId: string;
};

export type YouTubeUploadItem = {
  videoId: string;
  title: string;
  publishedAt: Date;
};

/** The channel (or its uploads playlist) does not exist — e.g. a mistyped handle. */
export class YouTubeChannelNotFoundError extends Error {}

/** 400/403 from the API: invalid key or quota exhausted. Retrying later may help for quota. */
export class YouTubeApiAuthError extends Error {}

/** Network failure or an unexpected/unparseable API response. */
export class YouTubeApiError extends Error {}

type FetchLike = (url: string) => Promise<Pick<Response, "ok" | "status" | "json">>;

function requireApiKey(): string {
  const key = env.YOUTUBE_API_KEY;
  if (!key) {
    throw new YouTubeApiAuthError(
      "YOUTUBE_API_KEY is not configured. Channel import requires a YouTube Data API v3 key.",
    );
  }
  return key;
}

async function requestJson(fetchFn: FetchLike, url: string): Promise<unknown> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchFn(url);
  } catch {
    throw new YouTubeApiError("Could not reach the YouTube API (network failure).");
  }

  if (response.status === 400 || response.status === 403) {
    const reason = await extractErrorReason(response);
    throw new YouTubeApiAuthError(
      `YouTube API rejected the request (HTTP ${response.status}${reason ? `, ${reason}` : ""}). ` +
        "The API key may be invalid or the daily quota may be exhausted.",
    );
  }
  if (response.status === 404) {
    throw new YouTubeChannelNotFoundError("The YouTube API returned 404 for this resource.");
  }
  if (!response.ok) {
    throw new YouTubeApiError(`YouTube API request failed (HTTP ${response.status}).`);
  }

  try {
    return await response.json();
  } catch {
    throw new YouTubeApiError("YouTube API returned a response that was not valid JSON.");
  }
}

async function extractErrorReason(
  response: Awaited<ReturnType<FetchLike>>,
): Promise<string | null> {
  try {
    const body = (await response.json()) as {
      error?: { errors?: { reason?: string }[]; message?: string };
    };
    return body.error?.errors?.[0]?.reason ?? body.error?.message ?? null;
  } catch {
    return null;
  }
}

/** A raw YouTube channel id: "UC" + 22 id characters. */
export function looksLikeChannelId(input: string): boolean {
  return /^UC[0-9A-Za-z_-]{22}$/.test(input);
}

type ChannelsListJson = {
  items?: {
    id?: string;
    snippet?: { title?: string; customUrl?: string };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }[];
};

/**
 * Resolves a channel id ("UC...") or handle ("@name" / "name") to the channel's identity and
 * uploads playlist via `channels.list`. Throws `YouTubeChannelNotFoundError` when the API
 * returns no matching channel (its empty-`items` shape for unknown ids/handles).
 */
export async function resolveUploadsPlaylist(
  channelIdOrHandle: string,
  fetchFn: FetchLike = fetch,
): Promise<YouTubeChannel> {
  const key = requireApiKey();
  const input = channelIdOrHandle.trim();
  const params = new URLSearchParams({ part: "snippet,contentDetails", key });
  if (looksLikeChannelId(input)) {
    params.set("id", input);
  } else {
    params.set("forHandle", input.startsWith("@") ? input : `@${input}`);
  }

  const json = (await requestJson(fetchFn, `${API_BASE}/channels?${params}`)) as ChannelsListJson;
  const item = json.items?.[0];
  if (!item) {
    throw new YouTubeChannelNotFoundError(
      `No YouTube channel found for "${input}". Check the handle or channel id.`,
    );
  }

  const channelId = item.id;
  const uploadsPlaylistId = item.contentDetails?.relatedPlaylists?.uploads;
  if (!channelId || !uploadsPlaylistId) {
    throw new YouTubeApiError("YouTube API response was missing the channel id or uploads playlist.");
  }

  return {
    channelId,
    title: item.snippet?.title?.trim() || "Untitled channel",
    handle: item.snippet?.customUrl ?? null,
    uploadsPlaylistId,
  };
}

type PlaylistItemsListJson = {
  items?: {
    snippet?: { title?: string; publishedAt?: string };
    contentDetails?: { videoId?: string; videoPublishedAt?: string };
  }[];
};

/**
 * Lists the most recent uploads in an uploads playlist (newest first, single page of up to
 * `maxResults` — the poller stops at the first already-seen video, so one page is enough).
 * With `after`, only videos published strictly after that instant are returned. Throws
 * `YouTubeChannelNotFoundError` when the playlist no longer exists (channel deleted).
 */
export async function listRecentUploads(
  playlistId: string,
  { after, maxResults = 50 }: { after?: Date; maxResults?: number } = {},
  fetchFn: FetchLike = fetch,
): Promise<YouTubeUploadItem[]> {
  const key = requireApiKey();
  const params = new URLSearchParams({
    part: "snippet,contentDetails",
    playlistId,
    maxResults: String(maxResults),
    key,
  });

  const json = (await requestJson(
    fetchFn,
    `${API_BASE}/playlistItems?${params}`,
  )) as PlaylistItemsListJson;

  const uploads: YouTubeUploadItem[] = [];
  for (const item of json.items ?? []) {
    const videoId = item.contentDetails?.videoId;
    const publishedAtRaw = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
    if (!videoId || !publishedAtRaw) {
      continue;
    }
    const publishedAt = new Date(publishedAtRaw);
    if (Number.isNaN(publishedAt.getTime())) {
      continue;
    }
    if (after && publishedAt.getTime() <= after.getTime()) {
      continue;
    }
    uploads.push({
      videoId,
      title: item.snippet?.title?.trim() || "Untitled video",
      publishedAt,
    });
  }
  return uploads;
}
