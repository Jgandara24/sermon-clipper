import path from "node:path";
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
