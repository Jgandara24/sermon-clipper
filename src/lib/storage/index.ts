import path from "node:path";
import { LocalDiskStorageProvider } from "./local-disk-provider";
import type { StorageProvider } from "./types";

const globalForStorage = globalThis as unknown as {
  storageProvider?: StorageProvider;
};

export function getStorageProvider(): StorageProvider {
  if (!globalForStorage.storageProvider) {
    const root = process.env.STORAGE_LOCAL_ROOT
      ? path.resolve(process.env.STORAGE_LOCAL_ROOT)
      : path.resolve(process.cwd(), ".data", "storage");
    globalForStorage.storageProvider = new LocalDiskStorageProvider(root);
  }

  return globalForStorage.storageProvider;
}

export * from "./types";
