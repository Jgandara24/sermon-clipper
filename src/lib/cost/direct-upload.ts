import { storageTransferCostFact, type StorageProviderKind } from "@/lib/storage";
import { recordProcessingCostFact } from "./record";
import type { ProcessingCostFactInput, ProcessingCostOutcome } from "./types";

export type DirectUploadCostInput = {
  uploadId: string;
  bytes: number;
  wallTimeMs: number;
  attempt: number;
  railwayEgressPricePerGbUsd: number | null;
  storageProvider: StorageProviderKind;
  storageUploadPricePerGbUsd: number | null;
  outcome: ProcessingCostOutcome;
};

/** Builds the three transfer facts for one browser-to-object-storage upload attempt. */
export function buildDirectUploadCostFacts(
  input: DirectUploadCostInput,
): ProcessingCostFactInput[] {
  const quantityGb = input.bytes / 1_000_000_000;
  const common = {
    quantity: quantityGb,
    unit: "gigabyte" as const,
    bytes: input.bytes,
    wallTimeMs: input.wallTimeMs,
    cacheState: "not_applicable" as const,
    attempt: input.attempt,
    outcome: input.outcome,
  };

  return [
    {
      ...common,
      stage: "source_acquisition",
      unitCostUsd: 0,
      provider: "browser_direct",
      model: null,
      providerProvenance: "signed_upload_runtime",
      details: { uploadId: input.uploadId, proxyUsed: false },
    },
    {
      ...common,
      stage: "upload",
      unitCostUsd: input.railwayEgressPricePerGbUsd,
      provider: "railway_egress",
      model: null,
      providerProvenance: "signed_upload_runtime",
      details: { uploadId: input.uploadId, transfer: "web_to_object_storage" },
    },
    {
      ...storageTransferCostFact({
        direction: "upload",
        bytes: input.bytes,
        provider: input.storageProvider,
        configuredPricePerGbUsd: input.storageUploadPricePerGbUsd,
        wallTimeMs: input.wallTimeMs,
        attempt: input.attempt,
        outcome: input.outcome,
      }),
      details: { uploadId: input.uploadId },
    },
  ];
}

/** Records upload metering without making an observability failure break a completed transfer. */
export async function recordDirectUploadCostFactsSafely(
  client: Parameters<typeof recordProcessingCostFact>[0],
  attribution: { workspaceId: string },
  input: DirectUploadCostInput,
): Promise<void> {
  try {
    for (const fact of buildDirectUploadCostFacts(input)) {
      await recordProcessingCostFact(client, { ...fact, ...attribution });
    }
  } catch (error) {
    console.error("[cost] failed to record direct-upload cost facts", error);
  }
}
