import path from "node:path";
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
  const provider = process.env.STORAGE_PROVIDER ?? "local";

  if (provider === "s3") {
    const bucket = requiredEnv("STORAGE_S3_BUCKET");
    const region = process.env.STORAGE_S3_REGION ?? "auto";
    const accessKeyId = requiredEnv("STORAGE_S3_ACCESS_KEY_ID");
    const secretAccessKey = requiredEnv("STORAGE_S3_SECRET_ACCESS_KEY");
    return new S3StorageProvider({
      bucket,
      region,
      endpoint: process.env.STORAGE_S3_ENDPOINT,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: process.env.STORAGE_S3_FORCE_PATH_STYLE === "true",
    });
  }

  if (provider === "local") {
    const root = process.env.STORAGE_LOCAL_ROOT
      ? path.resolve(process.env.STORAGE_LOCAL_ROOT)
      : path.resolve(process.cwd(), ".data", "storage");
    return new LocalDiskStorageProvider(root);
  }

  throw new Error(`Unsupported STORAGE_PROVIDER "${provider}". Use "local" or "s3".`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required when STORAGE_PROVIDER=s3.`);
  }
  return value;
}

export * from "./types";
