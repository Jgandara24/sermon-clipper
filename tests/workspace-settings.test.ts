import { describe, expect, it } from "vitest";
import { updateWorkspaceSettings, WorkspaceSettingsConflictError } from "@/lib/workspace-settings";
import { parseDeliverySettings } from "@/lib/delivery/settings";

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

describe("parseDeliverySettings", () => {
  it("defaults both switches off for a workspace that has never been configured", () => {
    expect(parseDeliverySettings(null)).toEqual({
      customerApprovalRequired: false,
      pilotHold: false,
    });
  });

  it("reads both switches when they are set", () => {
    expect(
      parseDeliverySettings({ delivery: { customerApprovalRequired: true, pilotHold: true } }),
    ).toEqual({ customerApprovalRequired: true, pilotHold: true });
  });

  // Both switches decide whether something reaches an audience, so anything that is not exactly
  // the boolean true has to read as off. A stored string "true" is a configuration mistake, not
  // permission to publish.
  it.each([["true"], [1], ["yes"], [{}], [null]])("treats %o as off", (value) => {
    expect(
      parseDeliverySettings({ delivery: { customerApprovalRequired: value, pilotHold: value } }),
    ).toEqual({ customerApprovalRequired: false, pilotHold: false });
  });

  it("ignores a delivery key that is not an object", () => {
    expect(parseDeliverySettings({ delivery: "on" })).toEqual({
      customerApprovalRequired: false,
      pilotHold: false,
    });
  });

  it("leaves other settings sections alone", () => {
    const settings = { churchProfile: { timezone: "UTC" }, delivery: { pilotHold: true } };
    expect(parseDeliverySettings(settings).pilotHold).toBe(true);
  });
});
