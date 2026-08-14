export const PROCESSING_COST_FACT_SCHEMA_VERSION = 1;

export type ProcessingCostStage =
  | "source_acquisition"
  | "upload"
  | "download"
  | "local_audio_extraction"
  | "transcription"
  | "analysis_classification"
  | "analysis_scoring"
  | "storage"
  | "render";

export type ProcessingCostUnit =
  | "call"
  | "byte"
  | "gigabyte"
  | "second"
  | "minute"
  | "token"
  | "image"
  | "operation"
  | "gigabyte_day";

export type ProcessingCacheState = "hit" | "miss" | "partial" | "not_applicable" | "unknown";
export type ProcessingCostOutcome = "succeeded" | "failed";
export type ProcessingCostDetails = Record<string, string | number | boolean | null>;

export type ProcessingCostFactInput = {
  stage: ProcessingCostStage;
  quantity: number;
  unit: ProcessingCostUnit;
  unitCostUsd: number | null;
  provider: string;
  model: string | null;
  providerProvenance: string;
  bytes?: number | null;
  cpuTimeMs?: number | null;
  wallTimeMs?: number | null;
  cacheState?: ProcessingCacheState;
  attempt?: number;
  outcome?: ProcessingCostOutcome;
  details?: ProcessingCostDetails;
};

export type ProcessingCostFact = ProcessingCostFactInput & {
  schemaVersion: typeof PROCESSING_COST_FACT_SCHEMA_VERSION;
  pricingStatus: "priced" | "zero_cost" | "unpriced";
  totalCostUsd: number | null;
  bytes: number | null;
  cpuTimeMs: number | null;
  wallTimeMs: number | null;
  cacheState: ProcessingCacheState;
  attempt: number;
  retry: boolean;
  outcome: ProcessingCostOutcome;
};

function requireNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number.`);
  }
  return value;
}

function optionalNonNegative(value: number | null | undefined, name: string): number | null {
  return value === null || value === undefined ? null : requireNonNegative(value, name);
}

/** Validates and normalizes one raw processing cost fact. */
export function buildProcessingCostFact(input: ProcessingCostFactInput): ProcessingCostFact {
  const quantity = requireNonNegative(input.quantity, "quantity");
  const unitCostUsd = optionalNonNegative(input.unitCostUsd, "unitCostUsd");
  const attempt = input.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be a positive integer.");
  }
  if (!input.provider.trim() || !input.providerProvenance.trim()) {
    throw new Error("provider and providerProvenance are required.");
  }

  const pricingStatus =
    unitCostUsd === null ? "unpriced" : unitCostUsd === 0 ? "zero_cost" : "priced";
  return {
    ...input,
    schemaVersion: PROCESSING_COST_FACT_SCHEMA_VERSION,
    quantity,
    unitCostUsd,
    pricingStatus,
    totalCostUsd: unitCostUsd === null ? null : quantity * unitCostUsd,
    bytes: optionalNonNegative(input.bytes, "bytes"),
    cpuTimeMs: optionalNonNegative(input.cpuTimeMs, "cpuTimeMs"),
    wallTimeMs: optionalNonNegative(input.wallTimeMs, "wallTimeMs"),
    cacheState: input.cacheState ?? "unknown",
    attempt,
    retry: attempt > 1,
    outcome: input.outcome ?? "succeeded",
  };
}
