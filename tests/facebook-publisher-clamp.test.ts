import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishDueScheduledPosts } from "@/lib/integrations/facebook-publisher";
import type { PublishScheduledVideoInput } from "@/lib/integrations/facebook";

// Deliberately fake test-only token; never a real credential.
const originalToken = process.env.META_SYSTEM_USER_TOKEN;
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

beforeAll(() => {
  process.env.META_SYSTEM_USER_TOKEN = "test-system-user-token-not-real";
  // The publisher fails closed on unset/localhost app URLs (finding #9).
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
});

afterAll(() => {
  if (originalToken === undefined) delete process.env.META_SYSTEM_USER_TOKEN;
  else process.env.META_SYSTEM_USER_TOKEN = originalToken;
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
});

const eligibleSettings = {
  churchProfile: { timezone: "America/Chicago", serviceDay: "Sunday", sermonsPerWeek: 1, postsPerDay: 1 },
  facebookConnection: { pageId: "1128280933691493", autoPostEnabled: true },
};

/** One due row + capture of the scheduledPost query/update payloads; no real DB. */
function makeFakeClient(scheduledDate: Date, options: { attemptCount?: number } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const findManyWheres: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const client = {
    scheduledPost: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        findManyWheres.push(where);
        return [
          {
            id: "post-1",
            workspaceId: "ws-1",
            scheduledDate,
            attemptCount: options.attemptCount ?? 0,
            workspace: { settings: eligibleSettings },
            clip: {
              title: "Clip title",
              hookText: "You need to hear this.",
              exportJobs: [{ outputFile: { storageKey: "exports/ws-1/clip.mp4" } }],
            },
          },
        ];
      },
      updateMany: async () => ({ count: 1 }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      },
    },
    operationalEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return {};
      },
    },
  };
  return { client, updates, findManyWheres, events };
}

async function runPoller(
  scheduledDate: Date,
  nowIso: string,
  options: { attemptCount?: number; publishError?: Error } = {},
) {
  const { client, updates, findManyWheres, events } = makeFakeClient(scheduledDate, options);
  const publishCalls: PublishScheduledVideoInput[] = [];

  const summary = await publishDueScheduledPosts(client as never, {
    now: () => new Date(nowIso),
    resolvePageAccessToken: async () => "page-token-abc",
    publishScheduledVideo: async (input) => {
      if (options.publishError) throw options.publishError;
      publishCalls.push(input);
      return { facebookPostId: "fb-video-123" };
    },
  });

  return { summary, publishCalls, updates, findManyWheres, events };
}

// scheduledDate 2026-07-20 in America/Chicago (CDT): 9am local = 2026-07-20T14:00:00Z.
const scheduledDate = new Date("2026-07-20T00:00:00Z");

describe("publishDueScheduledPosts publish-time clamp", () => {
  it("publishes immediately when the 9am-local target is already past", async () => {
    const { summary, publishCalls, updates } = await runPoller(scheduledDate, "2026-07-20T15:00:00Z");

    expect(summary.postsPublished).toBe(1);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].scheduledPublishAt).toBeUndefined();
    expect(updates[0].publishStatus).toBe("SUCCEEDED");
    expect((updates[0].publishedAt as Date).toISOString()).toBe("2026-07-20T15:00:00.000Z");
  });

  it("publishes immediately when the target is inside the minimum scheduling lead", async () => {
    // 14 minutes before 9am local — below Meta's ~10-minute floor plus margin.
    const { publishCalls } = await runPoller(scheduledDate, "2026-07-20T13:46:00Z");
    expect(publishCalls[0].scheduledPublishAt).toBeUndefined();
  });

  it("schedules for 9am church-local when the target is far enough out", async () => {
    const { publishCalls, updates } = await runPoller(scheduledDate, "2026-07-20T01:00:00Z");

    expect(publishCalls[0].scheduledPublishAt?.toISOString()).toBe("2026-07-20T14:00:00.000Z");
    expect((updates[0].publishedAt as Date).toISOString()).toBe("2026-07-20T14:00:00.000Z");
  });

  it("still schedules at exactly the minimum lead boundary", async () => {
    const { publishCalls } = await runPoller(scheduledDate, "2026-07-20T13:45:00Z");
    expect(publishCalls[0].scheduledPublishAt?.toISOString()).toBe("2026-07-20T14:00:00.000Z");
  });
});

describe("publishDueScheduledPosts app-URL misconfiguration", () => {
  async function runWithAppUrl(value: string | undefined) {
    const saved = process.env.NEXT_PUBLIC_APP_URL;
    if (value === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = value;
    try {
      return await runPoller(scheduledDate, "2026-07-20T15:00:00Z");
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
      else process.env.NEXT_PUBLIC_APP_URL = saved;
    }
  }

  it("skips publishing entirely when NEXT_PUBLIC_APP_URL is unset", async () => {
    const { summary, publishCalls, updates, events } = await runWithAppUrl(undefined);

    expect(publishCalls).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(summary.postsSkippedMisconfigured).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("facebook_publish_misconfigured");
    expect(events[0].severity).toBe("error");
  });

  it("treats a localhost app URL the same as unset", async () => {
    const { publishCalls, updates, summary } = await runWithAppUrl("http://localhost:3000");

    expect(publishCalls).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(summary.postsSkippedMisconfigured).toBe(1);
  });
});

describe("publishDueScheduledPosts retry behavior", () => {
  const nowIso = "2026-07-20T15:00:00Z";

  it("re-queues a transient failure with backoff instead of failing terminally", async () => {
    const { summary, updates } = await runPoller(scheduledDate, nowIso, {
      publishError: new Error("Could not reach the Facebook Graph API (network failure)."),
    });

    expect(summary.postsFailed).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].publishStatus).toBe("NOT_STARTED");
    expect(updates[0].attemptCount).toBe(1);
    // First retry backs off 5 minutes.
    expect((updates[0].nextAttemptAt as Date).toISOString()).toBe("2026-07-20T15:05:00.000Z");
  });

  it("fails terminally on the final attempt", async () => {
    const { updates } = await runPoller(scheduledDate, nowIso, {
      attemptCount: 4,
      publishError: new Error("HTTP 500"),
    });

    expect(updates[0].publishStatus).toBe("FAILED");
    expect(updates[0].attemptCount).toBe(5);
    expect(updates[0].nextAttemptAt).toBeNull();
  });

  it("only queries rows whose nextAttemptAt is unset or due", async () => {
    const { findManyWheres } = await runPoller(scheduledDate, nowIso);

    expect(findManyWheres[0].OR).toEqual([
      { nextAttemptAt: null },
      { nextAttemptAt: { lte: new Date(nowIso) } },
    ]);
    // Detached history rows (clip regenerated after publish) are never selected as due.
    expect(findManyWheres[0].clipId).toEqual({ not: null });
  });
});
