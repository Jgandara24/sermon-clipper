import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Provider spend telemetry for AI analysis. Token usage is captured per model call in the
 * ClaudeAnalysisProvider, estimated in USD here, attached to ANALYZE job metadata, and rolled up
 * per workspace on /app/settings/operations. Estimates use list prices — the invoice from
 * Anthropic is the source of truth; this exists so cost drift is visible in-app, not exact.
 */

export type AnalysisModelCall = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
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

function readUsageFromMetadata(metadata: Prisma.JsonValue): AnalysisUsage | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const usage = (metadata as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
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
 * Rolls up estimated Claude spend from analysis success events for one workspace. For a
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
      category: "analysis",
      eventType: "processing_job_succeeded",
      createdAt: { gte: since },
    },
    select: { metadata: true },
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

  for (const event of events) {
    const usage = readUsageFromMetadata(event.metadata);
    if (!usage) {
      continue; // heuristic-provider jobs carry no usage — they cost nothing
    }
    summary.jobCount += 1;
    summary.totalInputTokens += usage.totalInputTokens;
    summary.totalOutputTokens += usage.totalOutputTokens;
    summary.estimatedCostUsd += usage.estimatedCostUsd;
    if (usage.unpricedModels && usage.unpricedModels.length > 0) {
      summary.incomplete = true;
    }
  }

  return summary;
}
