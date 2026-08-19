import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publishDueScheduledPosts } from "@/lib/integrations/facebook-publisher";

const originalToken = process.env.META_SYSTEM_USER_TOKEN;
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
const originalPublishingEnabled = process.env.AUTOMATIC_PUBLISHING_ENABLED;

beforeAll(() => {
  process.env.META_SYSTEM_USER_TOKEN = "test-system-user-token-not-real";
  process.env.AUTOMATIC_PUBLISHING_ENABLED = "true";
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

function makeClient(options: { heldProjectIds: string[] }) {
  const claims: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const client = {
    scheduledPost: {
      findMany: async () => [
        {
          id: "post-1",
          workspaceId: "ws-1",
          scheduledDate: new Date("2026-07-20T00:00:00Z"),
          attemptCount: 0,
          workspace: {
            settings: eligibleSettings,
            accessPlan: "PAID",
            trialStartedAt: new Date("2026-01-01T00:00:00Z"),
            trialEndsAt: new Date("2026-01-31T00:00:00Z"),
            paidAt: new Date("2026-01-05T00:00:00Z"),
          },
          clip: {
            projectId: "proj-1",
            title: "Clip title",
            hookText: "You need to hear this.",
            exportJobs: [{ outputFile: { storageKey: "exports/ws-1/clip.mp4" } }],
          },
        },
      ],
      updateMany: async ({ where }: { where: { id: string } }) => {
        claims.push(where.id);
        return { count: 1 };
      },
      update: async () => ({}),
    },
    editorialException: {
      findMany: async () => options.heldProjectIds.map((projectId) => ({ projectId })),
    },
    operationalEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return {};
      },
    },
  };
  return { client, claims, events };
}

async function run(heldProjectIds: string[]) {
  const { client, claims, events } = makeClient({ heldProjectIds });
  let metaCalls = 0;
  const summary = await publishDueScheduledPosts(client as never, {
    now: () => new Date("2026-07-20T15:00:00Z"),
    resolvePageAccessToken: async () => "page-token-abc",
    publishScheduledVideo: async () => {
      metaCalls++;
      return { facebookPostId: "fb-video-123" };
    },
  });
  return { summary, claims, events, metaCalls };
}

// A transcript the configured primary provider did not produce degrades exactly what a published
// clip shows: caption text and word timing. Those clips stay editable, but a person decides
// whether they go out — the automatic publisher never does.
describe("publishDueScheduledPosts transcription fallback hold", () => {
  it("does not publish or claim a post whose project is held", async () => {
    const { summary, claims, metaCalls } = await run(["proj-1"]);

    expect(summary.postsPublished).toBe(0);
    expect(summary.postsSkippedNotEligible).toBe(1);
    expect(claims).toHaveLength(0);
    expect(metaCalls).toBe(0);
  });

  it("says why it skipped, without provider error text", async () => {
    const { events } = await run(["proj-1"]);

    const skipped = events.filter(
      (event) => event.eventType === "facebook_publish_skipped_transcription_hold",
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0].severity).toBe("warning");
    expect(JSON.stringify(skipped[0].metadata)).not.toMatch(/error|stack|exception:/i);
  });

  it("publishes normally when the project carries no hold", async () => {
    const { summary, metaCalls } = await run([]);

    expect(summary.postsPublished).toBe(1);
    expect(metaCalls).toBe(1);
  });
});
