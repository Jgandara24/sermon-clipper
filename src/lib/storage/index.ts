import { prisma } from "@/lib/prisma";
import { recordProcessingCostFactSafely } from "@/lib/cost/record";
import { multipartMeasurementWorkspace, multipartRequestCostFact, parseMultipartRequestPricing } from "./multipart-measurement";
import path from "node:path";
import type { ProcessingCostFactInput, ProcessingCostOutcome } from "@/lib/cost/types";
import { env } from "@/lib/env";
import { LocalDiskStorageProvider } from "./local-disk-provider";
import { S3StorageProvider } from "./s3-provider";
import { CachedStorageProvider } from "./cached-provider";
import type { StorageDownloadResult, StorageProvider } from "./types";

const globalForStorage = globalThis as unknown as {
  storageProvider?: StorageProvider;
};

export function getStorageProvider(): StorageProvider {
  if (!globalForStorage.storageProvider) {
    const provider = createStorageProvider();
    globalForStorage.storageProvider = env.STORAGE_CACHE_MAX_BYTES > 0
      ? new CachedStorageProvider(provider, {
        root: path.resolve(requiredEnv("STORAGE_CACHE_ROOT", env.STORAGE_CACHE_ROOT)),
        maxBytes: env.STORAGE_CACHE_MAX_BYTES,
      })
      : provider;
  }

  return globalForStorage.storageProvider;
}

export async function closeStorageProvider() {
  const provider = globalForStorage.storageProvider;
  if (provider instanceof CachedStorageProvider) await provider.close();
  globalForStorage.storageProvider = undefined;
}

export type StorageProviderKind = "local" | "s3";

export function storageProviderKind(): StorageProviderKind {
  return env.STORAGE_PROVIDER === "s3" ? "s3" : "local";
}

export function storageTransferCostFact(input: {
  direction: "download" | "upload";
  bytes: number;
  provider: StorageProviderKind;
  configuredPricePerGbUsd: number | null;
  wallTimeMs: number;
  attempt: number;
  outcome: ProcessingCostOutcome;
  download?: StorageDownloadResult | void;
}): ProcessingCostFactInput {
  const bytes = input.direction === "download" ? input.download?.transferredBytes ?? input.bytes : input.bytes;
  return {
    stage: input.direction,
    quantity: bytes / 1_000_000_000,
    unit: "gigabyte",
    unitCostUsd: input.provider === "local" ? 0 : input.configuredPricePerGbUsd,
    provider: `${input.provider}_storage`,
    model: null,
    providerProvenance: "storage_provider_config",
    bytes,
    wallTimeMs: input.wallTimeMs,
    cacheState: input.direction === "download" ? input.download?.cacheState ?? "not_applicable" : "not_applicable",
    attempt: input.attempt,
    outcome: input.outcome,
  };
}

function createStorageProvider(): StorageProvider {
  const provider = env.STORAGE_PROVIDER;

  if (provider === "s3") {
    const multipartPricing = parseMultipartRequestPricing(env.STORAGE_MULTIPART_REQUEST_PRICING_JSON);
    const bucket = requiredEnv("STORAGE_S3_BUCKET", env.STORAGE_S3_BUCKET);
    const region = env.STORAGE_S3_REGION;
    const accessKeyId = requiredEnv("STORAGE_S3_ACCESS_KEY_ID", env.STORAGE_S3_ACCESS_KEY_ID);
    const secretAccessKey = requiredEnv("STORAGE_S3_SECRET_ACCESS_KEY", env.STORAGE_S3_SECRET_ACCESS_KEY);
    return new S3StorageProvider({
      bucket,
      region,
      endpoint: env.STORAGE_S3_ENDPOINT,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE,
      onMultipartRequest: async measurement => {
        const workspaceId = multipartMeasurementWorkspace(measurement);
        if (!workspaceId) {
          console.error("[cost] Multipart request has no valid workspace attribution.");
          return;
        }
        await recordProcessingCostFactSafely(prisma, { ...multipartRequestCostFact(measurement, multipartPricing), workspaceId });
      },
    });
  }

  if (provider === "local") {
    const root = env.STORAGE_LOCAL_ROOT
      ? path.resolve(env.STORAGE_LOCAL_ROOT)
      : path.resolve(process.cwd(), ".data", "storage");
    return new LocalDiskStorageProvider(root);
  }

  throw new Error(`Unsupported STORAGE_PROVIDER "${provider}". Use "local" or "s3".`);
}

function requiredEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required by the selected storage configuration.`);
  }
  return value;
}

export * from "./types";
