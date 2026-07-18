import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  YouTubeApiAuthError,
  YouTubeApiError,
  YouTubeChannelNotFoundError,
  listRecentUploads,
  looksLikeChannelId,
  resolveUploadsPlaylist,
} from "@/lib/integrations/youtube";

const CHANNEL_ID = "UCAOHpXtnB1c9BW7hqLg-3gQ";
const UPLOADS_ID = "UUAOHpXtnB1c9BW7hqLg-3gQ";

// Deliberately fake test-only key; never a real credential.
const FAKE_KEY = "test-youtube-key-not-real";
const originalKey = process.env.YOUTUBE_API_KEY;

beforeAll(() => {
  process.env.YOUTUBE_API_KEY = FAKE_KEY;
});

afterAll(() => {
  if (originalKey === undefined) delete process.env.YOUTUBE_API_KEY;
  else process.env.YOUTUBE_API_KEY = originalKey;
});

/** Canned Data API v3 channels.list response. */
function channelsFixture(overrides: Record<string, unknown> = {}) {
  return {
    kind: "youtube#channelListResponse",
    pageInfo: { totalResults: 1, resultsPerPage: 5 },
    items: [
      {
        kind: "youtube#channel",
        id: CHANNEL_ID,
        snippet: { title: "Grace Church", customUrl: "@gracechurch" },
        contentDetails: { relatedPlaylists: { likes: "", uploads: UPLOADS_ID } },
      },
    ],
    ...overrides,
  };
}

/** Canned Data API v3 playlistItems.list response (newest first, like the real API). */
function playlistItemsFixture() {
  return {
    kind: "youtube#playlistItemListResponse",
    pageInfo: { totalResults: 2, resultsPerPage: 50 },
    items: [
      {
        kind: "youtube#playlistItem",
        snippet: { title: "Newest Sermon", publishedAt: "2026-07-12T15:00:05Z" },
        contentDetails: { videoId: "vid-new-000", videoPublishedAt: "2026-07-12T15:00:00Z" },
      },
      {
        kind: "youtube#playlistItem",
        snippet: { title: "Older Sermon", publishedAt: "2026-07-05T15:00:05Z" },
        contentDetails: { videoId: "vid-old-000", videoPublishedAt: "2026-07-05T15:00:00Z" },
      },
    ],
  };
}

function fakeFetch(status: number, body: unknown) {
  const urls: string[] = [];
  const fetchFn = async (url: string) => {
    urls.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Pick<Response, "ok" | "status" | "json">;
  };
  return { fetchFn, urls };
}

describe("looksLikeChannelId", () => {
  it("accepts UC + 22 id characters and rejects everything else", () => {
    expect(looksLikeChannelId(CHANNEL_ID)).toBe(true);
    expect(looksLikeChannelId("@gracechurch")).toBe(false);
    expect(looksLikeChannelId("UCtooshort")).toBe(false);
    expect(looksLikeChannelId(`${CHANNEL_ID}extra`)).toBe(false);
  });
});

describe("resolveUploadsPlaylist", () => {
  it("resolves a handle to the uploads playlist via channels.list forHandle", async () => {
    const { fetchFn, urls } = fakeFetch(200, channelsFixture());

    const channel = await resolveUploadsPlaylist("@gracechurch", fetchFn);

    expect(channel).toEqual({
      channelId: CHANNEL_ID,
      title: "Grace Church",
      handle: "@gracechurch",
      uploadsPlaylistId: UPLOADS_ID,
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/youtube/v3/channels?");
    expect(urls[0]).toContain("forHandle=%40gracechurch");
    expect(urls[0]).toContain("part=snippet%2CcontentDetails");
    // Quota discipline: channels.list only, never search.list.
    expect(urls[0]).not.toContain("/search");
  });

  it("prefixes bare handles with @ and queries by id for UC... channel ids", async () => {
    const bare = fakeFetch(200, channelsFixture());
    await resolveUploadsPlaylist("gracechurch", bare.fetchFn);
    expect(bare.urls[0]).toContain("forHandle=%40gracechurch");

    const byId = fakeFetch(200, channelsFixture());
    await resolveUploadsPlaylist(CHANNEL_ID, byId.fetchFn);
    expect(byId.urls[0]).toContain(`id=${CHANNEL_ID}`);
    expect(byId.urls[0]).not.toContain("forHandle");
  });

  it("throws YouTubeChannelNotFoundError for the API's empty-items unknown-channel shape", async () => {
    const { fetchFn } = fakeFetch(
      200,
      channelsFixture({ items: [], pageInfo: { totalResults: 0, resultsPerPage: 5 } }),
    );

    await expect(resolveUploadsPlaylist("@nosuchchurch", fetchFn)).rejects.toThrow(
      YouTubeChannelNotFoundError,
    );
  });

  it("throws YouTubeApiAuthError on 403 quota/key rejection, without leaking the key", async () => {
    const { fetchFn } = fakeFetch(403, {
      error: {
        code: 403,
        message: "The request cannot be completed because you have exceeded your quota.",
        errors: [{ reason: "quotaExceeded", domain: "youtube.quota" }],
      },
    });

    const failure = await resolveUploadsPlaylist("@gracechurch", fetchFn).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(YouTubeApiAuthError);
    expect((failure as Error).message).toContain("quotaExceeded");
    expect((failure as Error).message).not.toContain(FAKE_KEY);
  });

  it("throws YouTubeApiAuthError when YOUTUBE_API_KEY is not configured, without calling fetch", async () => {
    delete process.env.YOUTUBE_API_KEY;
    try {
      const { fetchFn, urls } = fakeFetch(200, channelsFixture());
      await expect(resolveUploadsPlaylist("@gracechurch", fetchFn)).rejects.toThrow(
        YouTubeApiAuthError,
      );
      expect(urls).toHaveLength(0);
    } finally {
      process.env.YOUTUBE_API_KEY = FAKE_KEY;
    }
  });

  it("throws YouTubeApiError when the network request itself fails", async () => {
    const fetchFn = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(resolveUploadsPlaylist("@gracechurch", fetchFn)).rejects.toThrow(YouTubeApiError);
  });

  it("throws YouTubeApiError when the response is missing the uploads playlist", async () => {
    const { fetchFn } = fakeFetch(200, {
      items: [{ id: CHANNEL_ID, snippet: { title: "Grace Church" }, contentDetails: {} }],
    });

    await expect(resolveUploadsPlaylist("@gracechurch", fetchFn)).rejects.toThrow(YouTubeApiError);
  });
});

describe("listRecentUploads", () => {
  it("lists uploads via playlistItems.list with the video publish timestamps", async () => {
    const { fetchFn, urls } = fakeFetch(200, playlistItemsFixture());

    const uploads = await listRecentUploads(UPLOADS_ID, {}, fetchFn);

    expect(uploads).toEqual([
      {
        videoId: "vid-new-000",
        title: "Newest Sermon",
        publishedAt: new Date("2026-07-12T15:00:00Z"),
      },
      {
        videoId: "vid-old-000",
        title: "Older Sermon",
        publishedAt: new Date("2026-07-05T15:00:00Z"),
      },
    ]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/youtube/v3/playlistItems?");
    expect(urls[0]).toContain(`playlistId=${UPLOADS_ID}`);
    expect(urls[0]).toContain("maxResults=50");
    expect(urls[0]).not.toContain("/search");
  });

  it("filters out videos published at or before `after`", async () => {
    const { fetchFn } = fakeFetch(200, playlistItemsFixture());

    const uploads = await listRecentUploads(
      UPLOADS_ID,
      { after: new Date("2026-07-05T15:00:00Z") },
      fetchFn,
    );

    expect(uploads.map((u) => u.videoId)).toEqual(["vid-new-000"]);
  });

  it("skips malformed items rather than failing the whole page", async () => {
    const fixture = playlistItemsFixture();
    fixture.items.push({
      kind: "youtube#playlistItem",
      snippet: { title: "Broken", publishedAt: "" },
      contentDetails: { videoId: "", videoPublishedAt: "" },
    });
    const { fetchFn } = fakeFetch(200, fixture);

    const uploads = await listRecentUploads(UPLOADS_ID, {}, fetchFn);

    expect(uploads.map((u) => u.videoId)).toEqual(["vid-new-000", "vid-old-000"]);
  });

  it("throws YouTubeChannelNotFoundError when the playlist no longer exists (404)", async () => {
    const { fetchFn } = fakeFetch(404, {
      error: { code: 404, errors: [{ reason: "playlistNotFound" }] },
    });

    await expect(listRecentUploads(UPLOADS_ID, {}, fetchFn)).rejects.toThrow(
      YouTubeChannelNotFoundError,
    );
  });

  it("throws YouTubeApiAuthError on 403 quota errors", async () => {
    const { fetchFn } = fakeFetch(403, {
      error: { code: 403, errors: [{ reason: "quotaExceeded" }] },
    });

    await expect(listRecentUploads(UPLOADS_ID, {}, fetchFn)).rejects.toThrow(YouTubeApiAuthError);
  });
});
