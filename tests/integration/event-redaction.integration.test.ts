import { AuthProvider, Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditEventExposure } from "@/lib/audits/event-exposure";
import { purgeStoredEventExposure } from "@/lib/audits/event-redaction";

const prisma = new PrismaClient();
const proxyUrl = "http://churchuser:s3cretpass@gate.proxy.example:7777";

let workspaceId: string;
let userId: string;
const seededIds: string[] = [];

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function seed(input: {
  eventType: string;
  metadata: Prisma.InputJsonObject;
  workspaceScoped: boolean;
}) {
  const event = await prisma.operationalEvent.create({
    data: {
      workspaceId: input.workspaceScoped ? workspaceId : null,
      category: "processing",
      eventType: input.eventType,
      severity: "error",
      message: "seeded redaction fixture",
      metadata: input.metadata,
    },
  });
  seededIds.push(event.id);
  return event.id;
}

async function seedFixtures() {
  const leaked = await seed({
    eventType: "processing_job_failed",
    workspaceScoped: true,
    metadata: {
      type: "FINALIZE",
      errorCode: "URL_IMPORT_FAILED",
      attempt: 2,
      detail: `Command failed: yt-dlp --proxy ${proxyUrl} --dump-json https://youtu.be/x`,
    },
  });
  const ceiling = await seed({
    eventType: "processing_job_succeeded",
    workspaceScoped: true,
    metadata: { type: "ANALYZE", candidateLimit: 12, keptCount: 6, targetClipCount: 6 },
  });
  const override = await seed({
    eventType: "candidate_limit_override_set",
    workspaceScoped: true,
    metadata: { candidateLimitOverride: 12 },
  });
  const clean = await seed({
    eventType: "processing_job_succeeded",
    workspaceScoped: true,
    metadata: { type: "PROBE", attempt: 1 },
  });
  return { leaked, ceiling, override, clean };
}

beforeEach(async () => {
  if (seededIds.length > 0) {
    await prisma.operationalEvent.deleteMany({ where: { id: { in: seededIds } } });
    seededIds.length = 0;
  }
  await prisma.operationalEvent.deleteMany({
    where: { eventType: "stored_event_exposure_redacted" },
  });
  if (!workspaceId) {
    const user = await prisma.user.create({
      data: { email: `${unique("redaction")}@example.test`, authProvider: AuthProvider.DEV },
    });
    userId = user.id;
    const workspace = await prisma.workspace.create({
      data: { name: unique("redaction-ws"), owner: { connect: { id: user.id } } },
    });
    workspaceId = workspace.id;
  }
});

afterAll(async () => {
  await prisma.operationalEvent.deleteMany({ where: { id: { in: seededIds } } });
  await prisma.operationalEvent.deleteMany({
    where: { eventType: "stored_event_exposure_redacted" },
  });
  await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("stored event exposure redaction", () => {
  it("changes nothing in dry run", async () => {
    const ids = await seedFixtures();
    const before = await prisma.operationalEvent.findMany({
      where: { id: { in: Object.values(ids) } },
      orderBy: { id: "asc" },
    });

    const plan = await purgeStoredEventExposure(prisma, { proxyUrl });

    expect(plan.applied).toBe(false);
    expect(plan.totalEventCount).toBe(3);
    const after = await prisma.operationalEvent.findMany({
      where: { id: { in: Object.values(ids) } },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
    // The dry run must not record a remediation event either.
    await expect(
      prisma.operationalEvent.count({ where: { eventType: "stored_event_exposure_redacted" } }),
    ).resolves.toBe(0);
  });

  it("removes the secret, keeps the event, and records the remediation", async () => {
    const ids = await seedFixtures();

    const plan = await purgeStoredEventExposure(prisma, { proxyUrl, apply: true });

    expect(plan).toMatchObject({
      applied: true,
      proxySecretEventCount: 1,
      candidateCeilingEventCount: 1,
      overrideAuditRescopeCount: 1,
    });

    const leaked = await prisma.operationalEvent.findUniqueOrThrow({ where: { id: ids.leaked } });
    expect(JSON.stringify(leaked.metadata)).not.toContain("s3cretpass");
    expect(JSON.stringify(leaked.metadata)).not.toContain("gate.proxy.example");
    // The event survives with its diagnostic context intact.
    expect(leaked.metadata).toMatchObject({
      type: "FINALIZE",
      errorCode: "URL_IMPORT_FAILED",
      attempt: 2,
    });
    expect(leaked.eventType).toBe("processing_job_failed");

    const ceiling = await prisma.operationalEvent.findUniqueOrThrow({ where: { id: ids.ceiling } });
    expect(ceiling.metadata).toEqual({ type: "ANALYZE", keptCount: 6, targetClipCount: 6 });

    const override = await prisma.operationalEvent.findUniqueOrThrow({
      where: { id: ids.override },
    });
    expect(override.workspaceId).toBeNull();
    expect(override.metadata).toEqual({ workspaceId, candidateLimitOverride: 12 });

    const clean = await prisma.operationalEvent.findUniqueOrThrow({ where: { id: ids.clean } });
    expect(clean.metadata).toEqual({ type: "PROBE", attempt: 1 });

    const remediation = await prisma.operationalEvent.findFirstOrThrow({
      where: { eventType: "stored_event_exposure_redacted" },
    });
    expect(remediation.workspaceId).toBeNull();
    expect(remediation.metadata).toMatchObject({ totalEventCount: 3 });
    expect(JSON.stringify(remediation.metadata)).not.toContain("s3cretpass");
  });

  it("leaves the audit clean and is idempotent on a second run", async () => {
    await seedFixtures();
    await purgeStoredEventExposure(prisma, { proxyUrl, apply: true });

    const audit = await auditEventExposure(prisma, proxyUrl);
    expect(audit.proxyExposure.credentialEventCount).toBe(0);
    expect(audit.candidateLimitExposure.churchVisibleEventCount).toBe(0);

    const second = await purgeStoredEventExposure(prisma, { proxyUrl, apply: true });
    expect(second.totalEventCount).toBe(0);
  });
});
