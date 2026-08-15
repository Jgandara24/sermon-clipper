#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient, SourceOrigin } from "@prisma/client";
import {
  summarizeCostTruthReport,
  TYPICAL_SERVICES_PER_MONTH,
  validateCostTruthReport,
  type CostTruthReportInput,
} from "../src/lib/cost/report";
import { env } from "../src/lib/env";
import { getStorageProvider } from "../src/lib/storage";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) {
    throw new Error(
      "Usage: npm run create:project-cost-report -- --project-id <uuid> --output evaluation/<file>.json",
    );
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hostFromUrl(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for Gate A.`);
  try {
    return new URL(value).hostname;
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

function requiredPrice(value: number | undefined, name: string): number {
  if (value === undefined) throw new Error(`${name} is required for Gate A.`);
  return value;
}

function secondsForCharge(charge: CostTruthReportInput["charges"][number]): number {
  if (charge.unit === "second") return charge.quantity;
  if (charge.unit === "minute") return charge.quantity * 60;
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const projectId = requiredOption(args, "--project-id");
  const output = resolve(requiredOption(args, "--output"));
  const prisma = new PrismaClient();
  try {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: {
        workspaceId: true,
        sourceVideo: {
          select: {
            id: true,
            origin: true,
            durationS: true,
            sizeBytes: true,
            storageKey: true,
            audioKey: true,
            thumbnailKey: true,
            srtOverrideKey: true,
          },
        },
      },
    });
    const source = project.sourceVideo;
    if (!source?.durationS || !source.storageKey) {
      throw new Error("The project needs a measured, stored source video.");
    }

    let directUploadId: string | null = null;
    if (source.origin === SourceOrigin.UPLOAD) {
      const completion = await prisma.operationalEvent.findFirst({
        where: {
          workspaceId: project.workspaceId,
          eventType: "upload_completed",
          metadata: { path: ["sourceVideoId"], equals: source.id },
        },
        select: { metadata: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const completionMetadata = record(completion?.metadata);
      directUploadId =
        typeof completionMetadata.uploadId === "string" ? completionMetadata.uploadId : null;
      if (!directUploadId) {
        throw new Error("The direct-upload project has no attributable upload completion event.");
      }
    }

    const events = await prisma.operationalEvent.findMany({
      where: {
        category: "cost",
        eventType: "processing_cost_fact",
        OR: [
          { projectId },
          ...(directUploadId
            ? [
                {
                  workspaceId: project.workspaceId,
                  projectId: null,
                  metadata: { path: ["details", "uploadId"], equals: directUploadId },
                },
              ]
            : []),
        ],
      },
      select: { id: true, metadata: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const charges = events.map((event) => {
      const metadata = record(event.metadata);
      return {
        chargeId: event.id,
        stage: metadata.stage,
        provider: metadata.provider,
        model: metadata.model ?? null,
        providerProvenance: metadata.providerProvenance,
        quantity: metadata.quantity,
        unit: metadata.unit,
        unitCostUsd: metadata.unitCostUsd ?? null,
        pricingStatus: metadata.pricingStatus,
        totalCostUsd: metadata.totalCostUsd ?? null,
        bytes: metadata.bytes ?? null,
        cpuTimeMs: metadata.cpuTimeMs ?? null,
        wallTimeMs: metadata.wallTimeMs ?? null,
        attempt: metadata.attempt,
        retry: metadata.retry,
        outcome: metadata.outcome,
        details: record(metadata.details),
      } as CostTruthReportInput["charges"][number];
    });

    const outputFiles = await prisma.exportJob.findMany({
      where: { clip: { projectId }, outputFile: { isNot: null } },
      select: { outputFile: { select: { bytes: true, storageKey: true } } },
    });
    const storageKeys = new Set(
      [
        source.storageKey,
        source.audioKey,
        source.thumbnailKey,
        source.srtOverrideKey,
        ...outputFiles.map((job) => job.outputFile?.storageKey ?? null),
      ].filter((key): key is string => Boolean(key)),
    );
    const storage = getStorageProvider();
    const storageBytes = (
      await Promise.all([...storageKeys].map((key) => storage.size(key)))
    ).reduce((sum, bytes) => sum + bytes, 0);
    const sourceBytes = Number(source.sizeBytes ?? BigInt(await storage.size(source.storageKey)));
    const proxyBytes = charges
      .filter(
        (charge) =>
          charge.stage === "source_acquisition" && charge.details.proxyUsed === true,
      )
      .reduce((sum, charge) => sum + Number(charge.bytes ?? 0), 0);
    const transcriptionSeconds = charges
      .filter((charge) => charge.stage === "transcription")
      .reduce((sum, charge) => sum + secondsForCharge(charge), 0);
    const renderSeconds = charges
      .filter((charge) => charge.stage === "render")
      .reduce((sum, charge) => sum + secondsForCharge(charge), 0);
    const outputBytes = outputFiles.reduce(
      (sum, job) => sum + Number(job.outputFile?.bytes ?? BigInt(0)),
      0,
    );
    const proxyHost = charges
      .filter((charge) => charge.stage === "source_acquisition")
      .map((charge) => charge.details.proxyHost)
      .find((value): value is string => typeof value === "string" && value.length > 0);
    const intakePath = source.origin === SourceOrigin.UPLOAD ? "direct_upload" : "youtube_proxy";
    if (intakePath === "youtube_proxy" && !proxyHost) {
      throw new Error("No measured production proxy host was found.");
    }
    const intakeProvider = charges
      .filter((charge) => charge.stage === "source_acquisition")
      .map((charge) => charge.provider)
      .find((provider) => provider.length > 0);
    if (!intakeProvider) throw new Error("No measured source-acquisition provider was found.");

    const endpointHost = hostFromUrl(env.STORAGE_S3_ENDPOINT, "STORAGE_S3_ENDPOINT");
    // Run-time cost recording is best effort, so the artifact must state whether any fact was
    // dropped. The validator rejects a report with a non-zero count.
    const costFactRecordFailures = await prisma.operationalEvent.count({
      where: {
        workspaceId: project.workspaceId,
        projectId,
        eventType: "cost_fact_record_failed",
      },
    });
    const draft: CostTruthReportInput = {
      schemaVersion: 2,
      recordedAt: new Date().toISOString(),
      evidenceType: "real_service",
      source: {
        artifactId: `gate-a-${createHash("sha256").update(projectId).digest("hex").slice(0, 12)}`,
        durationSeconds: source.durationS.toNumber(),
        sourceBytes,
        proxyBytes,
        storageBytes,
        transcriptionSeconds,
        renderSeconds,
        outputBytes,
      },
      production: {
        intakePath,
        intakeProvider,
        relayProvider: "Railway",
        relayEgressPricePerGbUsd: requiredPrice(
          env.RAILWAY_EGRESS_PRICE_PER_GB_USD,
          "RAILWAY_EGRESS_PRICE_PER_GB_USD",
        ),
        proxyProvider:
          intakePath === "youtube_proxy"
            ? proxyHost?.endsWith("iproyal.com")
              ? "IPRoyal"
              : "residential proxy"
            : null,
        proxyEndpointHost: intakePath === "youtube_proxy" ? (proxyHost ?? null) : null,
        proxyContractedPricePerGbUsd:
          intakePath === "youtube_proxy"
            ? requiredPrice(
                env.YTDLP_PROXY_PRICE_PER_GB_USD,
                "YTDLP_PROXY_PRICE_PER_GB_USD",
              )
            : null,
        storageProvider: endpointHost.endsWith("r2.cloudflarestorage.com")
          ? "Cloudflare R2"
          : "S3-compatible storage",
        storageEndpointHost: endpointHost,
        storageEgressPricePerGbUsd: requiredPrice(
          env.STORAGE_DOWNLOAD_PRICE_PER_GB_USD,
          "STORAGE_DOWNLOAD_PRICE_PER_GB_USD",
        ),
      },
      sandboxAnchor: {
        artifactId: "clip-count-retest-8-11",
        analysisCostUsd: 0.156798,
        inputTokens: 74_662,
        outputTokens: 9_348,
      },
      projection: { servicesPerMonth: TYPICAL_SERVICES_PER_MONTH },
      recording: { costFactRecordFailures },
      charges,
      measuredTotals: {
        proxyCostPerSourceHourUsd: 0,
        intakeCostUsd: 0,
        coreCostPerServiceUsd: 0,
        serviceCostUsd: 0,
        projectedMonthlyChurchCostUsd: 0,
        retryCount: 0,
        gateAPassed: false,
      },
    };
    draft.measuredTotals = summarizeCostTruthReport(draft);
    const result = validateCostTruthReport(draft);
    if (!result.ok) {
      throw new Error(`Gate A report did not pass:\n${result.issues.map((issue) => `- ${issue}`).join("\n")}`);
    }
    writeFileSync(output, `${JSON.stringify(result.report, null, 2)}\n`, { flag: "wx" });
    console.log(`wrote ${output}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
