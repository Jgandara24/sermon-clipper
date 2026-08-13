import { AuthProvider, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseChurchProfile } from "@/lib/church-profile";
import { env } from "@/lib/env";
import {
  CandidateLimitOverrideInputError,
  readCandidateLimitOverride,
  setCandidateLimitOverride,
} from "@/lib/operations/candidate-limit-override";
import { updateWorkspaceSettings } from "@/lib/workspace-settings";

const prisma = new PrismaClient();

let userId: string;
let workspaceId: string;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function baselineSettings() {
  return {
    churchProfile: {
      timezone: "America/Chicago",
      serviceDay: "Sunday",
      sermonsPerWeek: 1,
      secondServiceDay: null,
      postsPerDay: 1,
    },
    internalOperations: { protectedNote: "keep" },
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("candidate-limit")}@example.test`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: "Candidate Limit Override",
      ownerId: user.id,
      settings: baselineSettings(),
    },
  });
  workspaceId = workspace.id;
});

beforeEach(async () => {
  await prisma.workspace.update({ where: { id: workspaceId }, data: { settings: baselineSettings() } });
  await prisma.operationalEvent.deleteMany({ where: { workspaceId } });
});

afterAll(async () => {
  await prisma.workspace.delete({ where: { id: workspaceId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("candidate-limit override operations", () => {
  it("sets an override for an explicit workspace UUID", async () => {
    await setCandidateLimitOverride(prisma, { workspaceId, candidateLimitOverride: 12 });

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(readCandidateLimitOverride(workspace.settings)).toBe(12);
  });

  it("rejects an invalid override without changing the stored settings", async () => {
    await expect(
      setCandidateLimitOverride(prisma, { workspaceId, candidateLimitOverride: 0 }),
    ).rejects.toBeInstanceOf(CandidateLimitOverrideInputError);

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(readCandidateLimitOverride(workspace.settings)).toBeUndefined();
  });

  it("rejects an override above the master maximum", async () => {
    await expect(
      setCandidateLimitOverride(prisma, {
        workspaceId,
        candidateLimitOverride: env.CANDIDATE_LIMIT_MAXIMUM + 1,
      }),
    ).rejects.toBeInstanceOf(CandidateLimitOverrideInputError);
  });

  it("requires an explicit workspace UUID", async () => {
    await expect(
      setCandidateLimitOverride(prisma, {
        workspaceId: "Candidate Limit Override",
        candidateLimitOverride: 10,
      }),
    ).rejects.toBeInstanceOf(CandidateLimitOverrideInputError);
  });

  it("clears the override and preserves the rest of the protected subtree", async () => {
    await setCandidateLimitOverride(prisma, { workspaceId, candidateLimitOverride: 12 });
    await setCandidateLimitOverride(prisma, { workspaceId, candidateLimitOverride: null });

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(readCandidateLimitOverride(workspace.settings)).toBeUndefined();
    expect((workspace.settings as { internalOperations: unknown }).internalOperations).toEqual({
      protectedNote: "keep",
    });
    const eventTypes = await prisma.operationalEvent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      select: { eventType: true },
    });
    expect(eventTypes).toEqual([
      { eventType: "candidate_limit_override_set" },
      { eventType: "candidate_limit_override_cleared" },
    ]);
  });

  it("records an audit event for the operations change", async () => {
    await setCandidateLimitOverride(prisma, { workspaceId, candidateLimitOverride: 12 });

    const event = await prisma.operationalEvent.findFirstOrThrow({
      where: { workspaceId, eventType: "candidate_limit_override_set" },
    });
    expect(event.category).toBe("analysis");
    expect(event.severity).toBe("info");
    expect(event.metadata).toEqual({ candidateLimitOverride: 12 });
  });

  it("retries a concurrent settings update without losing either change", async () => {
    let forceConflict = true;
    const conflictingClient = prisma.$extends({
      query: {
        workspace: {
          async updateMany({ args, query }) {
            if (forceConflict) {
              forceConflict = false;
              await prisma.workspace.update({
                where: { id: workspaceId },
                data: {
                  settings: { ...baselineSettings(), concurrentSetting: "preserved" },
                  updatedAt: new Date(Date.now() + 1_000),
                },
              });
            }
            return query(args);
          },
        },
      },
    });

    await setCandidateLimitOverride(conflictingClient as unknown as PrismaClient, {
      workspaceId,
      candidateLimitOverride: 12,
    });

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(readCandidateLimitOverride(workspace.settings)).toBe(12);
    expect((workspace.settings as { concurrentSetting: unknown }).concurrentSetting).toBe("preserved");
  });

  it("preserves the protected subtree during a church settings write", async () => {
    await setCandidateLimitOverride(prisma, { workspaceId, candidateLimitOverride: 12 });

    await updateWorkspaceSettings(prisma, workspaceId, () => ({
      churchProfile: {
        timezone: "Pacific/Honolulu",
        serviceDay: "Saturday",
        sermonsPerWeek: 2,
        secondServiceDay: "Wednesday",
        postsPerDay: 1,
      },
    }));

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(readCandidateLimitOverride(workspace.settings)).toBe(12);
  });

  it("does not expose the internal override through the public church profile", async () => {
    await setCandidateLimitOverride(prisma, { workspaceId, candidateLimitOverride: 12 });

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const profile = parseChurchProfile(workspace.settings);
    expect(profile).toEqual({
      timezone: "America/Chicago",
      serviceDay: "Sunday",
      sermonsPerWeek: 1,
      secondServiceDay: null,
      postsPerDay: 1,
    });
    expect(profile).not.toHaveProperty("candidateLimitOverride");
    expect(profile).not.toHaveProperty("internalOperations");
  });
});
