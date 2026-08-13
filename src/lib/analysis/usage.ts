import type { Prisma, PrismaClient } from "@prisma/client";
import type { ProcessingCostFactInput, ProcessingCostStage } from "@/lib/cost/types";

/**
 * Provider spend telemetry for AI analysis. Token usage is captured per model call in the
 * ClaudeAnalysisProvider and estimated in USD here. ANALYZE records each call through the shared
 * processing-cost contract; /app/settings/operations rolls up those facts. Estimates use list
 * prices — the invoice from Anthropic is the source of truth.
 */

export type AnalysisModelCall = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  wallTimeMs?: number;
  outcome?: "succeeded" | "failed";
};

export type AnalysisUsage = {
  calls: AnalysisModelCall[];
  totalInputTokens: number;
  totalOutputTokens: number;
  /** USD, list-price estimate. Calls on models missing from the pricing table contribute 0. */
  estimatedCostUsd: number;
  /** Models we could not price — non-empty means estimatedCostUsd undercounts. */
  unpricedModels: string[];
};

// USD per million tokens (list prices; cache writes bill at 1.25x input, reads at 0.1x input).
const MODEL_PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 3, output: 15 },
};

const MTOK = 1_000_000;

export function estimateCallCostUsd(call: AnalysisModelCall): number | null {
  const pricing = MODEL_PRICING_PER_MTOK[call.model];
  if (!pricing) {
    return null;
  }
  return (
    (call.inputTokens * pricing.input +
      call.cacheCreationInputTokens * pricing.input * 1.25 +
      call.cacheReadInputTokens * pricing.input * 0.1 +
      call.outputTokens * pricing.output) /
    MTOK
  );
}

/** Converts one model call to the shared P0 cost-fact contract without recording it. */
export function analysisCallCostFact(
  call: AnalysisModelCall,
  stage: Extract<ProcessingCostStage, "analysis_classification" | "analysis_scoring">,
  providerProvenance: string,
): ProcessingCostFactInput {
  const cacheState =
    call.cacheReadInputTokens > 0
      ? "hit"
      : call.cacheCreationInputTokens > 0
        ? "partial"
        : "miss";
  return {
    stage,
    quantity: 1,
    unit: "call",
    unitCostUsd: estimateCallCostUsd(call),
    provider: "anthropic",
    model: call.model,
    providerProvenance,
    cacheState,
    wallTimeMs: call.wallTimeMs ?? null,
    details: {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheCreationInputTokens: call.cacheCreationInputTokens,
      cacheReadInputTokens: call.cacheReadInputTokens,
    },
  };
}

export function buildAnalysisUsage(calls: AnalysisModelCall[]): AnalysisUsage {
  let estimatedCostUsd = 0;
  const unpricedModels = new Set<string>();
  for (const call of calls) {
    const cost = estimateCallCostUsd(call);
    if (cost === null) {
      unpricedModels.add(call.model);
    } else {
      estimatedCostUsd += cost;
    }
  }
  return {
    calls,
    totalInputTokens: calls.reduce(
      (sum, c) => sum + c.inputTokens + c.cacheCreationInputTokens + c.cacheReadInputTokens,
      0,
    ),
    totalOutputTokens: calls.reduce((sum, c) => sum + c.outputTokens, 0),
    estimatedCostUsd,
    unpricedModels: [...unpricedModels],
  };
}

export type AnalysisSpendSummary = {
  windowDays: number;
  jobCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  /** True when any counted job carried usage we couldn't price, or events were truncated. */
  incomplete: boolean;
};

const SPEND_EVENT_SCAN_LIMIT = 1000;

type AnalysisCostMetadata = {
  provider: "anthropic";
  stage: "analysis_classification" | "analysis_scoring";
  totalCostUsd: number | null;
  pricingStatus: "priced" | "zero_cost" | "unpriced";
  details: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
};

function readAnalysisCostFromMetadata(metadata: Prisma.JsonValue): AnalysisCostMetadata | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const candidate = metadata as Partial<AnalysisCostMetadata>;
  if (
    candidate.provider !== "anthropic" ||
    (candidate.stage !== "analysis_classification" && candidate.stage !== "analysis_scoring") ||
    !candidate.details ||
    typeof candidate.details.inputTokens !== "number" ||
    typeof candidate.details.outputTokens !== "number" ||
    typeof candidate.details.cacheCreationInputTokens !== "number" ||
    typeof candidate.details.cacheReadInputTokens !== "number"
  ) {
    return null;
  }
  return candidate as AnalysisCostMetadata;
}

function readLegacyUsageFromMetadata(metadata: Prisma.JsonValue): AnalysisUsage | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const usage = (metadata as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const candidate = usage as Partial<AnalysisUsage>;
  if (
    typeof candidate.totalInputTokens !== "number" ||
    typeof candidate.totalOutputTokens !== "number" ||
    typeof candidate.estimatedCostUsd !== "number"
  ) {
    return null;
  }
  return candidate as AnalysisUsage;
}

/**
 * Rolls up estimated Claude spend from processing-cost facts for one workspace. For a
 * deployment-wide (all workspaces) figure, run the SQL documented in docs/DEPLOYMENT.md.
 */
export async function summarizeAnalysisSpend(
  client: PrismaClient,
  workspaceId: string,
  options?: { windowDays?: number; now?: Date },
): Promise<AnalysisSpendSummary> {
  const windowDays = options?.windowDays ?? 30;
  const now = options?.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const events = await client.operationalEvent.findMany({
    where: {
      workspaceId,
      createdAt: { gte: since },
      OR: [
        { category: "cost", eventType: "processing_cost_fact" },
        { category: "analysis", eventType: "processing_job_succeeded" },
      ],
    },
    select: { metadata: true, jobId: true },
    orderBy: { createdAt: "desc" },
    take: SPEND_EVENT_SCAN_LIMIT,
  });

  const summary: AnalysisSpendSummary = {
    windowDays,
    jobCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUsd: 0,
    incomplete: events.length >= SPEND_EVENT_SCAN_LIMIT,
  };

  const jobs = new Set<string>();
  const jobsWithCostFacts = new Set<string>();
  for (const event of events) {
    const fact = readAnalysisCostFromMetadata(event.metadata);
    if (!fact) continue;
    if (event.jobId) {
      jobs.add(event.jobId);
      jobsWithCostFacts.add(event.jobId);
    }
    summary.totalInputTokens +=
      fact.details.inputTokens +
      fact.details.cacheCreationInputTokens +
      fact.details.cacheReadInputTokens;
    summary.totalOutputTokens += fact.details.outputTokens;
    if (fact.totalCostUsd === null || fact.pricingStatus === "unpriced") {
      summary.incomplete = true;
    } else {
      summary.estimatedCostUsd += fact.totalCostUsd;
    }
  }

  // P0.12 stops writing usage into success metadata. Keep a dual-read for older events, but skip
  // any job that has shared cost facts so the same Claude calls are never counted twice.
  for (const event of events) {
    if (event.jobId && jobsWithCostFacts.has(event.jobId)) continue;
    const usage = readLegacyUsageFromMetadata(event.metadata);
    if (!usage) continue;
    if (event.jobId) jobs.add(event.jobId);
    summary.totalInputTokens += usage.totalInputTokens;
    summary.totalOutputTokens += usage.totalOutputTokens;
    summary.estimatedCostUsd += usage.estimatedCostUsd;
    if (usage.unpricedModels?.length > 0) summary.incomplete = true;
  }
  summary.jobCount = jobs.size;

  return summary;
}
