import { AuthProvider, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordOperationalEvent } from "@/lib/observability/operational-events";

const prisma = new PrismaClient();

let userId: string;
let workspaceId: string;

function uniqueKey(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `${uniqueKey("ops-events")}@example.com`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { name: "Operational Events Workspace", ownerId: user.id },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await prisma.workspace.delete({ where: { id: workspaceId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("operational events", () => {
  it("records a workspace-scoped event for operator diagnosis", async () => {
    const event = await recordOperationalEvent(prisma, {
      workspaceId,
      category: "worker",
      eventType: "test_worker_event",
      severity: "warning",
      message: "A test worker event was recorded.",
      metadata: { reason: "integration-test" },
    });

    const stored = await prisma.operationalEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(stored.workspaceId).toBe(workspaceId);
    expect(stored.category).toBe("worker");
    expect(stored.eventType).toBe("test_worker_event");
    expect(stored.severity).toBe("warning");
    expect(stored.metadata).toEqual({ reason: "integration-test" });
  });
});
