import { AuthProvider, Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditEventExposure } from "@/lib/audits/event-exposure";

const prisma = new PrismaClient();
const proxyUrl = "http://churchuser:s3cretpass@gate.proxy.example:7777";

let workspaceId: string;
let userId: string;
const eventIds: string[] = [];

function unique(label: string) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function seedEvent(input: {
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
      message: "seeded audit fixture",
      metadata: input.metadata,
    },
  });
  eventIds.push(event.id);
  return event;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `${unique("exposure")}@example.test`, authProvider: AuthProvider.DEV },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: { name: unique("exposure-ws"), owner: { connect: { id: user.id } } },
  });
  workspaceId = workspace.id;

  // A pre-fix job failure: the whole command line, credential included, in church-visible metadata.
  await seedEvent({
    eventType: "processing_job_failed",
    workspaceScoped: true,
    metadata: {
      type: "FINALIZE",
      errorCode: "URL_IMPORT_FAILED",
      detail: `Command failed: yt-dlp --proxy ${proxyUrl} --dump-json https://youtu.be/x`,
    },
  });
  // A post-fix failure: redacted at the source, but the marker survives.
  await seedEvent({
    eventType: "processing_job_retrying",
    workspaceScoped: true,
    metadata: { type: "FINALIZE", detail: "Command failed: yt-dlp --proxy [proxy-url] --dump-json" },
  });
  // A pre-fix failure whose credential lands across the excerpt boundary. Real yt-dlp command
  // lines are long, so the credential routinely sits past character 200. Truncating before
  // redacting cuts the credential in half, and neither half matches a whole-token needle, so
  // the leading fragment ("churchuser:s3cr...") used to survive into the printed sample.
  await seedEvent({
    eventType: "processing_job_failed",
    workspaceScoped: true,
    metadata: {
      // 140 pad + 31 prefix + 7 for the `{"d": "` JSON envelope puts the URL at about
      // character 178, so the 200-character cut lands inside the credential.
      d: `${"pad ".repeat(35)}Command failed: yt-dlp --proxy ${proxyUrl} --dump-json https://youtu.be/x`,
    },
  });
  // A pre-fix success event carrying the internal ceiling.
  await seedEvent({
    eventType: "processing_job_succeeded",
    workspaceScoped: true,
    metadata: { type: "ANALYZE", candidateLimit: 12, keptCount: 6 },
  });
  // The platform-scoped override audit is the fixed shape and must not be counted.
  await seedEvent({
    eventType: "candidate_limit_override_set",
    workspaceScoped: false,
    metadata: { workspaceId, candidateLimitOverride: 12 },
  });
});

afterAll(async () => {
  await prisma.operationalEvent.deleteMany({ where: { id: { in: eventIds } } });
  await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("stored event exposure audit", () => {
  it("finds leaked proxy credentials and never prints them", async () => {
    const audit = await auditEventExposure(prisma, proxyUrl);
    const mine = audit.proxyExposure.samples.filter((sample) => sample.workspaceId === workspaceId);

    expect(audit.proxyExposure.credentialEventCount).toBeGreaterThanOrEqual(1);
    expect(mine.some((sample) => sample.severity === "credential")).toBe(true);
    // The redacted-at-source row is still found by its marker, at a lower severity.
    expect(mine.some((sample) => sample.severity === "marker")).toBe(true);

    const printed = JSON.stringify(audit);
    expect(printed).not.toContain("s3cretpass");
    expect(printed).not.toContain("churchuser");
    expect(printed).not.toContain("gate.proxy.example");
  });

  it("redacts a credential that straddles the excerpt boundary", async () => {
    const audit = await auditEventExposure(prisma, proxyUrl);
    const straddling = audit.proxyExposure.samples.find((sample) =>
      sample.redactedExcerpt.includes("pad pad"),
    );

    // The fixture must actually reach the boundary, or this test proves nothing.
    expect(straddling).toBeDefined();
    expect(straddling?.redactedExcerpt).toHaveLength(200);
    // The cut lands inside the credential by construction, so the placeholder is truncated
    // too. That is fine — a partial "[proxy-cred..." discloses nothing.
    expect(straddling?.redactedExcerpt).toContain("[proxy-");
    // The leading fragment is the failure mode: truncate-then-redact left "churchuser:s3cr"
    // in place, because neither the full URL nor "churchuser:s3cretpass" nor "s3cretpass"
    // matched the cut string.
    expect(straddling?.redactedExcerpt).not.toContain("churchuser");
    expect(straddling?.redactedExcerpt).not.toContain("s3cr");
  });

  it("counts only church-visible candidate-ceiling events", async () => {
    const audit = await auditEventExposure(prisma, proxyUrl);

    expect(audit.candidateLimitExposure.byEventType).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "processing_job_succeeded" }),
      ]),
    );
    // The platform-scoped override audit event has no workspaceId, so it never reaches the
    // church-facing operations page and must not appear here.
    expect(audit.candidateLimitExposure.byEventType).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "candidate_limit_override_set" }),
      ]),
    );
    expect(audit.exposureFound).toBe(true);
  });

  it("still finds the bare marker when no proxy URL is supplied", async () => {
    const audit = await auditEventExposure(prisma, undefined);

    expect(audit.proxyExposure.configuredProxyUrlPresent).toBe(false);
    expect(audit.proxyExposure.matchedEventCount).toBeGreaterThanOrEqual(2);
    expect(audit.proxyExposure.credentialEventCount).toBe(0);
  });
});
