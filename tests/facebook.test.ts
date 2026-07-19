import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FacebookApiAuthError,
  FacebookApiError,
  FacebookNotConfiguredError,
  publishScheduledVideo,
  resolvePageAccessToken,
} from "@/lib/integrations/facebook";

// Deliberately fake test-only token; never a real credential.
const FAKE_TOKEN = "test-system-user-token-not-real";
const originalToken = process.env.META_SYSTEM_USER_TOKEN;

beforeAll(() => {
  process.env.META_SYSTEM_USER_TOKEN = FAKE_TOKEN;
});

afterAll(() => {
  if (originalToken === undefined) delete process.env.META_SYSTEM_USER_TOKEN;
  else process.env.META_SYSTEM_USER_TOKEN = originalToken;
});

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("resolvePageAccessToken", () => {
  it("fails closed when META_SYSTEM_USER_TOKEN is unset", async () => {
    const saved = process.env.META_SYSTEM_USER_TOKEN;
    delete process.env.META_SYSTEM_USER_TOKEN;
    await expect(resolvePageAccessToken("123", async () => jsonResponse(200, {}))).rejects.toThrow(
      FacebookNotConfiguredError,
    );
    process.env.META_SYSTEM_USER_TOKEN = saved;
  });

  it("returns the page access token on success", async () => {
    const token = await resolvePageAccessToken("123", async (url) => {
      expect(url).toContain("/123?");
      expect(url).toContain("fields=access_token");
      return jsonResponse(200, { access_token: "page-token-abc" });
    });
    expect(token).toBe("page-token-abc");
  });

  it("throws FacebookApiAuthError on 401/403", async () => {
    await expect(
      resolvePageAccessToken("123", async () =>
        jsonResponse(403, { error: { message: "Invalid OAuth access token" } }),
      ),
    ).rejects.toThrow(FacebookApiAuthError);
  });

  it("throws FacebookApiError when access_token is missing from a 200 response", async () => {
    await expect(
      resolvePageAccessToken("123", async () => jsonResponse(200, {})),
    ).rejects.toThrow(FacebookApiError);
  });
});

describe("publishScheduledVideo", () => {
  const input = {
    pageId: "1128280933691493",
    pageAccessToken: "page-token-abc",
    fileUrl: "https://example.com/signed/clip.mp4",
    caption: "Sunday's message",
    scheduledPublishAt: new Date("2026-07-20T14:00:00Z"),
  };

  it("posts the expected form fields and returns the facebook post id", async () => {
    const facebookPostId = await publishScheduledVideo(input, async (url, init) => {
      expect(url).toContain(`/${input.pageId}/videos`);
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(init?.body ?? "");
      expect(body.get("file_url")).toBe(input.fileUrl);
      expect(body.get("description")).toBe(input.caption);
      expect(body.get("published")).toBe("false");
      expect(body.get("scheduled_publish_time")).toBe(
        String(Math.floor(input.scheduledPublishAt.getTime() / 1000)),
      );
      return jsonResponse(200, { id: "fb-video-123" });
    }).then((result) => result.facebookPostId);

    expect(facebookPostId).toBe("fb-video-123");
  });

  it("omits scheduling fields to publish immediately when scheduledPublishAt is absent", async () => {
    const immediateInput = {
      pageId: input.pageId,
      pageAccessToken: input.pageAccessToken,
      fileUrl: input.fileUrl,
      caption: input.caption,
    };
    const result = await publishScheduledVideo(immediateInput, async (url, init) => {
      const body = new URLSearchParams(init?.body ?? "");
      expect(body.get("file_url")).toBe(input.fileUrl);
      expect(body.has("published")).toBe(false);
      expect(body.has("scheduled_publish_time")).toBe(false);
      return jsonResponse(200, { id: "fb-video-456" });
    });

    expect(result.facebookPostId).toBe("fb-video-456");
  });

  it("throws FacebookApiError on a non-2xx response", async () => {
    await expect(
      publishScheduledVideo(input, async () =>
        jsonResponse(500, { error: { message: "Internal error" } }),
      ),
    ).rejects.toThrow(FacebookApiError);
  });
});
