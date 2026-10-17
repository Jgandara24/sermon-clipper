import { stat } from "node:fs/promises";
import type { ProcessingCostFactInput } from "@/lib/cost/types";
import { StorageDownloadError, type StorageDownloadResult, type StorageProvider } from "./types";

export type PublicationStorageAccounting = {
  provider: "local" | "s3";
  downloadPricePerGbUsd: number | null;
  uploadPricePerGbUsd: number | null;
  attempt: number;
};

/** Measures the file transfers used by source leases and artifact publication.
 * Unknown partial transfers remain unpriced. The recorder must not throw.
 * Bind untouched methods to the original provider, including private-field implementations.
 */
export function measurePublicationStorage(storage: StorageProvider, settings: PublicationStorageAccounting,
  record: (fact: ProcessingCostFactInput) => Promise<void>): StorageProvider {
  if (!Number.isInteger(settings.attempt) || settings.attempt < 1) throw new Error("STORAGE_ACCOUNTING_ATTEMPT_INVALID");
  for (const price of [settings.downloadPricePerGbUsd, settings.uploadPricePerGbUsd]) {
    if (price !== null && (!Number.isFinite(price) || price < 0)) throw new Error("STORAGE_ACCOUNTING_PRICE_INVALID");
  }
  const measure = async <T>(direction: "download" | "upload", operation: string, filePath: string,
    transfer: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    let bytes: number | null = null;
    let download: StorageDownloadResult | void = undefined;
    let outcome: "succeeded" | "failed" = "failed";
    try {
      const result = await transfer();
      outcome = "succeeded";
      if (direction === "download") download = result as StorageDownloadResult | void;
      bytes = download?.transferredBytes ?? await stat(filePath).then(info => info.size, () => null);
      return result;
    } catch (error) {
      if (error instanceof StorageDownloadError) {
        download = error.download;
        bytes = download?.transferredBytes ?? null;
      }
      throw error;
    } finally {
      const price = direction === "download" ? settings.downloadPricePerGbUsd : settings.uploadPricePerGbUsd;
      await record({ stage: direction, quantity: bytes === null ? 0 : bytes / 1_000_000_000, unit: "gigabyte",
        unitCostUsd: bytes === null ? null : settings.provider === "local" ? 0 : price,
        provider: `${settings.provider}_storage`, model: null, providerProvenance: "publication_storage_accounting",
        bytes, wallTimeMs: Date.now() - started, cacheState: download?.cacheState ?? "not_applicable",
        attempt: settings.attempt, outcome, details: { operation, transferBytesKnown: bytes !== null } });
    }
  };
  return new Proxy(storage, { get(target, property) {
    if (property === "downloadToFile") return (key: string, destination: string, expected?: Parameters<StorageProvider["downloadToFile"]>[2]) =>
      measure("download", "downloadToFile", destination, () => target.downloadToFile(key, destination, expected));
    if (property === "uploadFileIfAbsent" && target.uploadFileIfAbsent) return (key: string, source: string, contentType?: string) =>
      measure("upload", "uploadFileIfAbsent", source, () => target.uploadFileIfAbsent!(key, source, contentType));
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
