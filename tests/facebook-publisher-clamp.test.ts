import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishDueScheduledPosts } from "@/lib/integrations/facebook-publisher";
import type { PublishScheduledVideoInput } from "@/lib/integrations/facebook";

// Deliberately fake test-only token; never a real credential.
const originalToken = process.env.META_SYSTEM_USER_TOKEN;

beforeAll(() => {
  process.env.META_SYSTEM_USER_TOKEN = "test-system-user-token-not-real";
});

afterAll(() => {
  if (originalToken === undefined) delete process.env.META_SYSTEM_USER_TOKEN;
  else process.env.META_SYSTEM_USER_TOKEN = originalToken;
});

const eligibleSettings = {
  churchProfile: { timezone: "America/Chicago", serviceDay: "Sunday", sermonsPerWeek: 1, postsPerDay: 1 },
  facebookConnection: { pageId: "1128280933691493", autoPostEnabled: true },
};

/** One due row + capture of the scheduledPost.update payload; no real DB. */
function makeFakeClient(scheduledDate: Date) {
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    scheduledPost: {
      findMany: async () => [
        {
          id: "post-1",
          workspaceId: "ws-1",
          scheduledDate,
          workspace: { settings: eligibleSettings },
          clip: {
            title: "Clip title",
            hookText: "You need to hear this.",
            exportJobs: [{ outputFile: { storageKey: "exports/ws-1/clip.mp4" } }],
          },
        },
      ],
      updateMany: async () => ({ count: 1 }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      },
    },
    operationalEvent: { create: async () => ({}) },
  };
  return { client, updates };
}

async function runPoller(scheduledDate: Date, nowIso: string) {
  const { client, updates } = makeFakeClient(scheduledDate);
  const publishCalls: PublishScheduledVideoInput[] = [];

  const summary = await publishDueScheduledPosts(client as never, {
    now: () => new Date(nowIso),
    resolvePageAccessToken: async () => "page-token-abc",
    publishScheduledVideo: async (input) => {
      publishCalls.push(input);
      return { facebookPostId: "fb-video-123" };
    },
  });

  return { summary, publishCalls, updates };
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
