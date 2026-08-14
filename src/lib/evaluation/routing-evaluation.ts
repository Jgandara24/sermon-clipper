import { computeFunnelMetrics, type FunnelRun } from "./funnel-metrics";
import type { AnalysisRoutingSnapshot } from "@/lib/analysis/routing";
import type { AnalysisUsage } from "@/lib/analysis/usage";
import type { ScoredCandidate } from "@/lib/analysis/types";

export function buildRoutingEvaluationReport(input: {
  projectId: string;
  sourceDurationMs: number;
  candidateCount: number;
  scored: ScoredCandidate[];
  routing: AnalysisRoutingSnapshot;
  usage: AnalysisUsage | null;
  wallTimeMs: number;
  startedAt: Date;
}) {
  const funnel: FunnelRun = {
    candidateCount: input.candidateCount,
    scoredCount: input.scored.length,
    keptCount: input.scored.length,
    sourceDurationMs: input.sourceDurationMs,
    clips: input.scored.map((clip, index) => ({
      rank: index + 1,
      startMs: clip.startMs,
      endMs: clip.endMs,
    })),
  };
  return {
    schemaVersion: 1,
    mode: "shadow_no_customer_mutation" as const,
    startedAt: input.startedAt.toISOString(),
    projectId: input.projectId,
    routing: input.routing,
    wallTimeMs: input.wallTimeMs,
    counts: {
      candidateCount: input.candidateCount,
      scoredCount: input.scored.length,
    },
    funnelMetrics: computeFunnelMetrics(funnel),
    usage: input.usage,
    clips: input.scored.map((clip, index) => ({
      rank: index + 1,
      startMs: clip.startMs,
      endMs: clip.endMs,
      total: clip.total,
      modelVersion: clip.modelVersion,
    })),
    humanReview: {
      requiredBeforePromotion: true,
      fields: ["accepted", "replacementRequired", "editorialQualityNote"],
    },
  };
}
