import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishDueScheduledPosts } from "@/lib/integrations/facebook-publisher";
import type { PublishScheduledVideoInput } from "@/lib/integrations/facebook";

// Deliberately fake test-only token; never a real credential.
const originalToken = process.env.META_SYSTEM_USER_TOKEN;
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
const originalPublishingEnabled = process.env.AUTOMATIC_PUBLISHING_ENABLED;

beforeAll(() => {
  process.env.META_SYSTEM_USER_TOKEN = "test-system-user-token-not-real";
  process.env.AUTOMATIC_PUBLISHING_ENABLED = "true";
  // The publisher fails closed on unset/localhost app URLs (finding #9).
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
});

afterAll(() => {
  if (originalToken === undefined) delete process.env.META_SYSTEM_USER_TOKEN;
  else process.env.META_SYSTEM_USER_TOKEN = originalToken;
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
  if (originalPublishingEnabled === undefined) delete process.env.AUTOMATIC_PUBLISHING_ENABLED;
  else process.env.AUTOMATIC_PUBLISHING_ENABLED = originalPublishingEnabled;
});

const eligibleSettings = {
  churchProfile: { timezone: "America/Chicago", serviceDay: "Sunday", sermonsPerWeek: 1, postsPerDay: 1 },
  facebookConnection: { pageId: "1128280933691493", autoPostEnabled: true },
};

const CLIP_ID = "11111111-1111-4111-8111-111111111111";
const EXPORT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

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
            workspace: {
              settings: eligibleSettings,
              accessPlan: "PAID",
              trialStartedAt: new Date("2026-01-01T00:00:00Z"),
              trialEndsAt: new Date("2026-01-31T00:00:00Z"),
            },
            clip: {
              projectId: PROJECT_ID,
              title: "Clip title",
              hookText: "You need to hear this.",
            },
            // The slot's own binding. The publisher no longer looks for the clip's newest
            // successful export, so this is the only route to a file.
            exportJob: { outputFile: { storageKey: "exports/ws-1/clip.mp4" } },
          },
        ];
      },
      updateMany: async () => ({ count: 1 }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      },
    },
    // The clip now carries a projectId, so the transcription-fallback hold check actually runs.
    // No project is held in these cases.
    editorialException: { findMany: async () => [] },
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
    // These cases are about clamping, retry and misconfiguration — the code past the delivery
    // gate. The real rule refuses every slot until P2 records editorial reviews, so it is stubbed
    // eligible here; tests/delivery-eligibility.test.ts covers the rule itself exhaustively.
    assessDelivery: async () => ({ eligible: true as const }),
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

describe("publishDueScheduledPosts global kill switch", () => {
  it("makes no query, claim, or Meta call for missing, false, and malformed values", async () => {
    // An enabled call starts a new switch period. This makes the one-event assertion independent
    // from any earlier disabled call in the same test process.
    await runPoller(scheduledDate, "2026-07-20T15:00:00Z");

    const { client, updates, findManyWheres, events } = makeFakeClient(scheduledDate);
    let metaCalls = 0;
    for (const value of [undefined, "false", "TRUE", "malformed"]) {
      if (value === undefined) delete process.env.AUTOMATIC_PUBLISHING_ENABLED;
      else process.env.AUTOMATIC_PUBLISHING_ENABLED = value;
      const summary = await publishDueScheduledPosts(client as never, {
        resolvePageAccessToken: async () => {
          metaCalls++;
          return "unused";
        },
        publishScheduledVideo: async () => {
          metaCalls++;
          return { facebookPostId: "unused" };
        },
      });
      expect(summary.postsScanned).toBe(0);
    }

    expect(findManyWheres).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(metaCalls).toBe(0);
    expect(events.filter((event) => event.eventType === "automatic_publishing_disabled")).toHaveLength(1);
    process.env.AUTOMATIC_PUBLISHING_ENABLED = "true";
  });
});

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

/**
 * The wiring itself, with nothing stubbed.
 *
 * Every case above injects an eligible verdict so it can reach the clamp and retry code. These
 * two prove the injection is not hiding anything: with the real module in place the publisher
 * consults it, refuses, and never claims the row.
 */
describe("publishDueScheduledPosts delivery gate", () => {
  it("refuses through the real rule, because no editorial review exists before P2", async () => {
    const { client, updates, events } = makeFakeClient(new Date("2026-03-02T00:00:00.000Z"));
    let claimed = false;
    const publishCalls: unknown[] = [];

    const summary = await publishDueScheduledPosts(
      {
        ...client,
        scheduledPost: {
          ...client.scheduledPost,
          // The real loader reads the slot back before deciding.
          findUnique: async () => ({
            workspaceId: "ws-1",
            projectId: PROJECT_ID,
            clipId: CLIP_ID,
            exportJobId: EXPORT_ID,
            publishStatus: "NOT_STARTED",
            workspace: { settings: eligibleSettings },
            clip: {
              id: CLIP_ID,
              workspaceId: "ws-1",
              projectId: PROJECT_ID,
              supersededAt: null,
              edits: [{ version: 2 }],
              approvals: [{ state: "APPROVED" }],
            },
            exportJob: {
              id: EXPORT_ID,
              workspaceId: "ws-1",
              clipId: CLIP_ID,
              state: "SUCCEEDED",
              editVersion: 2,
              qcStatus: "PASSED",
              qcChecksum: "sha256:fixture",
              outputFile: { checksum: "sha256:fixture" },
            },
          }),
          updateMany: async () => {
            claimed = true;
            return { count: 1 };
          },
        },
      } as never,
      {
        now: () => new Date("2026-03-02T12:00:00.000Z"),
        resolvePageAccessToken: async () => "page-token-abc",
        publishScheduledVideo: async (input) => {
          publishCalls.push(input);
          return { facebookPostId: "fb-video-123" };
        },
      },
    );

    expect(summary.postsPublished).toBe(0);
    expect(summary.postsSkippedNotEligible).toBe(1);
    expect(publishCalls).toHaveLength(0);
    // Nothing was claimed, so the slot stays available for when P2 makes it eligible.
    expect(claimed).toBe(false);
    expect(updates).toHaveLength(0);
    expect(
      events.some((event) => event.eventType === "facebook_publish_ineligible"),
    ).toBe(true);
  });

  it("reads the file from the slot's bound export, never from the clip's newest one", async () => {
    const { client } = makeFakeClient(new Date("2026-03-02T00:00:00.000Z"));
    const captured: string[] = [];

    await publishDueScheduledPosts(client as never, {
      now: () => new Date("2026-03-02T12:00:00.000Z"),
      assessDelivery: async () => ({ eligible: true as const }),
      resolvePageAccessToken: async () => "page-token-abc",
      publishScheduledVideo: async (input) => {
        captured.push(input.fileUrl);
        return { facebookPostId: "fb-video-123" };
      },
    });

    // The fixture's only export is the bound one; the clip carries no exportJobs list at all,
    // so a reintroduced "latest successful export" lookup would find nothing and fail this.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("exports%2Fws-1%2Fclip.mp4");
  });
});
