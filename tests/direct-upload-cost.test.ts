import { describe, expect, it } from "vitest";
import { buildDirectUploadCostFacts } from "@/lib/cost/direct-upload";

describe("direct browser upload cost facts", () => {
  it("meters acquisition, Railway egress, and storage upload from measured bytes", () => {
    const facts = buildDirectUploadCostFacts({
      uploadId: "upload-1",
      bytes: 400_000_000,
      wallTimeMs: 12_000,
      attempt: 2,
      railwayEgressPricePerGbUsd: 0.05,
      storageProvider: "s3",
      storageUploadPricePerGbUsd: 0,
      outcome: "succeeded",
    });

    expect(facts).toHaveLength(3);
    expect(facts).toEqual([
      expect.objectContaining({
        stage: "source_acquisition",
        provider: "browser_direct",
        quantity: 0.4,
        unitCostUsd: 0,
        bytes: 400_000_000,
        attempt: 2,
        details: { uploadId: "upload-1", proxyUsed: false },
      }),
      expect.objectContaining({
        stage: "upload",
        provider: "railway_egress",
        quantity: 0.4,
        unitCostUsd: 0.05,
        bytes: 400_000_000,
        attempt: 2,
        details: { uploadId: "upload-1", transfer: "web_to_object_storage" },
      }),
      expect.objectContaining({
        stage: "upload",
        provider: "s3_storage",
        quantity: 0.4,
        unitCostUsd: 0,
        bytes: 400_000_000,
        attempt: 2,
        details: { uploadId: "upload-1" },
      }),
    ]);
  });

  it("leaves paid transfer units unpriced when production prices are missing", () => {
    const facts = buildDirectUploadCostFacts({
      uploadId: "upload-2",
      bytes: 1_000,
      wallTimeMs: 1,
      attempt: 1,
      railwayEgressPricePerGbUsd: null,
      storageProvider: "s3",
      storageUploadPricePerGbUsd: null,
      outcome: "failed",
    });

    expect(facts[1]?.unitCostUsd).toBeNull();
    expect(facts[2]?.unitCostUsd).toBeNull();
    expect(facts.every((fact) => fact.outcome === "failed")).toBe(true);
  });
});
