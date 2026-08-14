import { z } from "zod";

export const analysisProviderKindSchema = z.enum([
  "anthropic",
  "openai",
  "google",
  "heuristic",
]);

const stageRouteSchema = z.object({
  provider: analysisProviderKindSchema,
  model: z.string().trim().min(1),
});

export const analysisRoutingSnapshotSchema = z.object({
  policyId: z.string().min(1),
  policyVersion: z.number().int().positive(),
  classification: stageRouteSchema,
  scoring: stageRouteSchema,
  promptVersion: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
});

export type AnalysisProviderKind = z.infer<typeof analysisProviderKindSchema>;
export type AnalysisRoutingSnapshot = z.infer<typeof analysisRoutingSnapshotSchema>;

export type AnalysisRoutingPolicy = {
  id: string;
  version: number;
  classification: AnalysisRoutingSnapshot["classification"];
  scoring: AnalysisRoutingSnapshot["scoring"];
  promptVersion: number;
  schemaVersion: number;
};

export type AnalysisModelPrice = {
  provider: AnalysisProviderKind;
  model: string;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  inputPerMillionUsd: number;
  cacheReadPerMillionUsd: number | null;
  cacheWritePerMillionUsd: number | null;
  outputPerMillionUsd: number;
  pricingSourceUrl: string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function snapshotAnalysisRouting(policy: AnalysisRoutingPolicy): AnalysisRoutingSnapshot {
  return analysisRoutingSnapshotSchema.parse({
    policyId: policy.id,
    policyVersion: policy.version,
    classification: policy.classification,
    scoring: policy.scoring,
    promptVersion: policy.promptVersion,
    schemaVersion: policy.schemaVersion,
  });
}

/** Keeps project analysis reproducible while master routing changes for later work. */
export function resolveProjectAnalysisRouting(
  processingConfig: unknown,
  masterPolicy: AnalysisRoutingPolicy,
): {
  routing: AnalysisRoutingSnapshot;
  source: "project_snapshot" | "master_policy";
} {
  const existing = analysisRoutingSnapshotSchema.safeParse(record(processingConfig).analysisRouting);
  if (existing.success) return { routing: existing.data, source: "project_snapshot" };
  return { routing: snapshotAnalysisRouting(masterPolicy), source: "master_policy" };
}

export function activeModelPrice(
  prices: AnalysisModelPrice[],
  route: AnalysisRoutingSnapshot["classification"],
  at: Date,
): AnalysisModelPrice | null {
  if (route.provider === "heuristic") return null;
  return (
    prices.find(
      (price) =>
        price.provider === route.provider &&
        price.model === route.model &&
        price.effectiveFrom <= at &&
        (price.effectiveUntil === null || price.effectiveUntil > at),
    ) ?? null
  );
}

/** Refuses activation when a paid model has no current, verified price. */
export function assertRoutingPolicyPriced(
  policy: AnalysisRoutingPolicy,
  prices: AnalysisModelPrice[],
  at = new Date(),
): void {
  const snapshot = snapshotAnalysisRouting(policy);
  for (const [stage, route] of [
    ["classification", snapshot.classification],
    ["scoring", snapshot.scoring],
  ] as const) {
    if (route.provider !== "heuristic" && !activeModelPrice(prices, route, at)) {
      throw new Error(
        `Cannot activate analysis routing: ${stage} model ${route.provider}/${route.model} has no active price.`,
      );
    }
  }
}
