import { describe, expect, it } from "vitest";
import { updateWorkspaceSettings, WorkspaceSettingsConflictError } from "@/lib/workspace-settings";

type FakeRow = {
  id: string;
  settings: Record<string, unknown>;
  updatedAt: Date;
};

/** Single-row fake honoring the {id, updatedAt} optimistic guard, with @updatedAt bump semantics. */
function makeFakeWorkspace(initialSettings: Record<string, unknown>) {
  const row: FakeRow = { id: "ws-1", settings: initialSettings, updatedAt: new Date(1_000) };
  const client = {
    workspace: {
      findUniqueOrThrow: async () => ({ settings: row.settings, updatedAt: row.updatedAt }),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; updatedAt: Date };
        data: { settings: Record<string, unknown> };
      }) => {
        if (where.id !== row.id || where.updatedAt.getTime() !== row.updatedAt.getTime()) {
          return { count: 0 };
        }
        row.settings = data.settings;
        row.updatedAt = new Date(row.updatedAt.getTime() + 1);
        return { count: 1 };
      },
    },
  };
  const commitConcurrentWrite = (mutate: (settings: Record<string, unknown>) => Record<string, unknown>) => {
    row.settings = mutate({ ...row.settings });
    row.updatedAt = new Date(row.updatedAt.getTime() + 1);
  };
  return { row, client, commitConcurrentWrite };
}

describe("updateWorkspaceSettings", () => {
  it("applies the mutation when nothing races", async () => {
    const { row, client } = makeFakeWorkspace({ churchProfile: { postsPerDay: 1 } });

    const result = await updateWorkspaceSettings(client as never, "ws-1", (settings) => ({
      ...settings,
      facebookConnection: { pageId: "123", autoPostEnabled: true },
    }));

    expect(result).toEqual({
      churchProfile: { postsPerDay: 1 },
      facebookConnection: { pageId: "123", autoPostEnabled: true },
    });
    expect(row.settings).toEqual(result);
  });

  it("retries after a concurrent write and preserves both changes", async () => {
    const { row, client, commitConcurrentWrite } = makeFakeWorkspace({ churchProfile: { postsPerDay: 1 } });

    // A concurrent save lands between our read and our guarded write on the first attempt:
    // the owner disables auto-posting while our church-profile save is in flight.
    let interleaved = false;
    const originalFind = client.workspace.findUniqueOrThrow;
    client.workspace.findUniqueOrThrow = async () => {
      const snapshot = await originalFind();
      if (!interleaved) {
        interleaved = true;
        commitConcurrentWrite((settings) => ({
          ...settings,
          facebookConnection: { pageId: "123", autoPostEnabled: false },
        }));
      }
      return snapshot;
    };

    await updateWorkspaceSettings(client as never, "ws-1", (settings) => ({
      ...settings,
      churchProfile: { postsPerDay: 3 },
    }));

    // The concurrent facebookConnection write survives, and our churchProfile change lands.
    expect(row.settings).toEqual({
      churchProfile: { postsPerDay: 3 },
      facebookConnection: { pageId: "123", autoPostEnabled: false },
    });
  });

  it("gives up with a clear error when the row keeps changing", async () => {
    const { client, commitConcurrentWrite } = makeFakeWorkspace({});

    const originalFind = client.workspace.findUniqueOrThrow;
    client.workspace.findUniqueOrThrow = async () => {
      const snapshot = await originalFind();
      commitConcurrentWrite((settings) => ({ ...settings, churn: Math.random() }));
      return snapshot;
    };

    await expect(
      updateWorkspaceSettings(client as never, "ws-1", (settings) => ({ ...settings, mine: true })),
    ).rejects.toBeInstanceOf(WorkspaceSettingsConflictError);
  });

  it("treats non-object settings as an empty object", async () => {
    const { row, client } = makeFakeWorkspace(null as never);

    await updateWorkspaceSettings(client as never, "ws-1", (settings) => ({ ...settings, a: 1 }));

    expect(row.settings).toEqual({ a: 1 });
  });
});
