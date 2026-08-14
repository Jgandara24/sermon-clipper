import path from "node:path";
import type { ProcessingCostFactInput, ProcessingCostOutcome } from "@/lib/cost/types";
import { env } from "@/lib/env";
import { LocalDiskStorageProvider } from "./local-disk-provider";
import { S3StorageProvider } from "./s3-provider";
import type { StorageProvider } from "./types";

const globalForStorage = globalThis as unknown as {
  storageProvider?: StorageProvider;
};

export function getStorageProvider(): StorageProvider {
  if (!globalForStorage.storageProvider) {
    globalForStorage.storageProvider = createStorageProvider();
  }

  return globalForStorage.storageProvider;
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
}): ProcessingCostFactInput {
  return {
    stage: input.direction,
    quantity: input.bytes / 1_000_000_000,
    unit: "gigabyte",
    unitCostUsd: input.provider === "local" ? 0 : input.configuredPricePerGbUsd,
    provider: `${input.provider}_storage`,
    model: null,
    providerProvenance: "storage_provider_config",
    bytes: input.bytes,
    wallTimeMs: input.wallTimeMs,
    cacheState: "not_applicable",
    attempt: input.attempt,
    outcome: input.outcome,
  };
}

function createStorageProvider(): StorageProvider {
  const provider = env.STORAGE_PROVIDER;

  if (provider === "s3") {
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
    throw new Error(`${name} is required when STORAGE_PROVIDER=s3.`);
  }
  return value;
}

export * from "./types";
