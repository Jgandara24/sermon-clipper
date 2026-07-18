import { AuthProvider, ChannelImportPlatform, PrismaClient, WorkspaceRole } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DuplicateChannelImportError,
  listChannelImportSources,
  registerChannelImportSource,
  setChannelImportSourceEnabled,
} from "@/lib/channel-import-service";
import type { YouTubeChannel } from "@/lib/integrations/youtube";

const prisma = new PrismaClient();

let workspaceId: string;
let otherWorkspaceId: string;
const createdWorkspaceIds: string[] = [];
const createdUserIds: string[] = [];

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Unique per test run so unique-constraint tests never collide with leftovers. */
const channelSuffix = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
const CHANNEL_ID = `UCitest0000000000${channelSuffix}`;

function fakeResolver(channel: Partial<YouTubeChannel> = {}) {
  const calls: string[] = [];
  const resolve = async (idOrHandle: string): Promise<YouTubeChannel> => {
    calls.push(idOrHandle);
    return {
      channelId: CHANNEL_ID,
      title: "Grace Church",
      handle: "@gracechurch",
      uploadsPlaylistId: `UU${CHANNEL_ID.slice(2)}`,
      ...channel,
    };
  };
  return { resolve, calls };
}

async function createWorkspace(label: string) {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey(label)}@example.com`, authProvider: AuthProvider.DEV },
  });
  createdUserIds.push(user.id);
  const workspace = await prisma.workspace.create({
    data: { name: label, ownerId: user.id },
  });
  createdWorkspaceIds.push(workspace.id);
  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: WorkspaceRole.OWNER },
  });
  return workspace.id;
}

beforeAll(async () => {
  workspaceId = await createWorkspace("Channel Import Service");
  otherWorkspaceId = await createWorkspace("Channel Import Other");
});

afterAll(async () => {
  // channel_import_sources cascade with their workspaces.
  await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe("registerChannelImportSource", () => {
  it("resolves the channel synchronously and persists the resolved identity", async () => {
    const { resolve, calls } = fakeResolver();

    const source = await registerChannelImportSource(
      prisma,
      workspaceId,
      "https://www.youtube.com/@gracechurch",
      resolve,
    );

    expect(calls).toEqual(["@gracechurch"]);
    expect(source.workspaceId).toBe(workspaceId);
    expect(source.platform).toBe(ChannelImportPlatform.YOUTUBE);
    expect(source.channelId).toBe(CHANNEL_ID);
    expect(source.channelHandle).toBe("@gracechurch");
    expect(source.channelTitle).toBe("Grace Church");
    expect(source.uploadsPlaylistId).toBe(`UU${CHANNEL_ID.slice(2)}`);
    expect(source.enabled).toBe(true);
    expect(source.lastPolledAt).toBeNull();

    // No bulk backfill on registration: no imported-video rows are seeded.
    const seeded = await prisma.channelImportedVideo.count({
      where: { channelImportSourceId: source.id },
    });
    expect(seeded).toBe(0);
  });

  it("rejects a duplicate channel for the same workspace via the unique constraint", async () => {
    const { resolve } = fakeResolver();

    await expect(
      registerChannelImportSource(prisma, workspaceId, "@gracechurch", resolve),
    ).rejects.toThrow(DuplicateChannelImportError);
  });

  it("allows a different workspace to register the same channel", async () => {
    const { resolve } = fakeResolver();

    const source = await registerChannelImportSource(
      prisma,
      otherWorkspaceId,
      "@gracechurch",
      resolve,
    );

    expect(source.workspaceId).toBe(otherWorkspaceId);
    expect(source.channelId).toBe(CHANNEL_ID);
  });

  it("propagates resolver failures without persisting a row", async () => {
    const before = await prisma.channelImportSource.count({ where: { workspaceId } });
    const failingResolver = async (): Promise<YouTubeChannel> => {
      throw new Error("channel could not be resolved");
    };

    await expect(
      registerChannelImportSource(prisma, workspaceId, "@brokenhandle", failingResolver),
    ).rejects.toThrow("channel could not be resolved");

    const after = await prisma.channelImportSource.count({ where: { workspaceId } });
    expect(after).toBe(before);
  });
});

describe("listChannelImportSources", () => {
  it("returns only the workspace's own sources", async () => {
    const mine = await listChannelImportSources(prisma, workspaceId);
    const theirs = await listChannelImportSources(prisma, otherWorkspaceId);

    expect(mine).toHaveLength(1);
    expect(mine[0].workspaceId).toBe(workspaceId);
    expect(theirs).toHaveLength(1);
    expect(theirs[0].workspaceId).toBe(otherWorkspaceId);
  });
});

describe("setChannelImportSourceEnabled", () => {
  it("disables and re-enables a source in its own workspace", async () => {
    const [source] = await listChannelImportSources(prisma, workspaceId);

    const disabled = await setChannelImportSourceEnabled(prisma, workspaceId, source.id, false);
    expect(disabled.enabled).toBe(false);

    const enabled = await setChannelImportSourceEnabled(prisma, workspaceId, source.id, true);
    expect(enabled.enabled).toBe(true);
  });

  it("refuses to touch a source belonging to another workspace", async () => {
    const [foreign] = await listChannelImportSources(prisma, otherWorkspaceId);

    await expect(
      setChannelImportSourceEnabled(prisma, workspaceId, foreign.id, false),
    ).rejects.toThrow(/Workspace access denied/);

    const untouched = await prisma.channelImportSource.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    expect(untouched.enabled).toBe(true);
  });
});
