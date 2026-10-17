import { z } from "zod";
import type { ProcessingCostFactInput } from "@/lib/cost/types";

const operations = ["CreateMultipartUpload", "CompleteMultipartUpload", "AbortMultipartUpload",
  "ListMultipartUploads", "ListParts", "HeadObject"] as const;
export type MultipartRequestOperation = typeof operations[number];
const pricingSchema = z.object({
  evidenceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  pricesPerRequestUsd: z.object(Object.fromEntries(operations.map(operation =>
    [operation, z.number().finite().nonnegative().optional()]))).strict(),
}).strict();
export type MultipartRequestPricing = {
  evidenceId: string | null;
  pricesPerRequestUsd: Partial<Record<MultipartRequestOperation, number>>;
};

/** Prices are explicit configured estimates, never inferred from a credential, vendor, or free-tier allowance. */
export function parseMultipartRequestPricing(raw?: string): MultipartRequestPricing {
  if (!raw?.trim()) return { evidenceId: null, pricesPerRequestUsd: {} };
  try {
    const parsed = pricingSchema.parse(JSON.parse(raw));
    return { evidenceId: parsed.evidenceId, pricesPerRequestUsd: parsed.pricesPerRequestUsd };
  } catch { throw new Error("MULTIPART_REQUEST_PRICING_INVALID"); }
}
export type MultipartRequestMeasurement = {
  sessionId: string; storageKey: string; requestId: string; operation: MultipartRequestOperation;
  wallTimeMs: number; outcome: "succeeded" | "failed"; httpStatus: number | null;
};

/** Counts server SDK calls. Browser PUTs and provider billing require separate evidence. */
export function multipartRequestCostFact(measurement: MultipartRequestMeasurement,
  pricing: MultipartRequestPricing = { evidenceId: null, pricesPerRequestUsd: {} }): ProcessingCostFactInput {
  const price = pricing.pricesPerRequestUsd[measurement.operation] ?? null;
  return { stage: "storage", quantity: 1, unit: "operation", unitCostUsd: price,
    provider: "s3_storage", model: null, providerProvenance: "multipart_control_request",
    bytes: null, wallTimeMs: measurement.wallTimeMs, cpuTimeMs: null,
    cacheState: "not_applicable", attempt: 1, outcome: measurement.outcome,
    details: { uploadId: measurement.sessionId, requestMeasurementId: measurement.requestId,
      operation: measurement.operation, pricingEvidenceId: pricing.evidenceId, requestPriceConfigured: price !== null, httpStatus: measurement.httpStatus, measurement: "sdk_call_attempt",
      sdkRetryPolicy: "single_attempt_in_shared_factory", browserBytesIncluded: false, providerBillingVerified: false } };
}

/** Only canonical durable-upload keys can provide workspace attribution. */
export function multipartMeasurementWorkspace(measurement: MultipartRequestMeasurement): string | null {
  const match = /^src\/([0-9a-f-]{36})\/multipart-([0-9a-f-]{36})$/.exec(measurement.storageKey);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  return match && uuid.test(match[1]) && match[2] === measurement.sessionId && uuid.test(match[2]) ? match[1] : null;
}
