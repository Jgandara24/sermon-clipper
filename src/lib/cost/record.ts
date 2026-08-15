import type { PrismaClient } from "@prisma/client";
import {
  recordOperationalEvent,
  recordOperationalEventSafely,
  type OperationalEventClient,
} from "@/lib/observability/operational-events";
import { buildProcessingCostFact, type ProcessingCostFactInput } from "./types";

export type ProcessingCostAttribution = {
  workspaceId: string;
  projectId?: string | null;
  clipId?: string | null;
  jobId?: string | null;
  exportJobId?: string | null;
};

export type RecordProcessingCostFactInput = ProcessingCostFactInput & ProcessingCostAttribution;

/** Records a COGS fact. It never reads or writes customer minute entitlements. */
export async function recordProcessingCostFact(
  client: OperationalEventClient | PrismaClient,
  input: RecordProcessingCostFactInput,
) {
  const { workspaceId, projectId, clipId, jobId, exportJobId, ...factInput } = input;
  const fact = buildProcessingCostFact(factInput);
  return recordOperationalEvent(client, {
    workspaceId,
    category: "cost",
    eventType: "processing_cost_fact",
    severity: fact.outcome === "failed" ? "warning" : "info",
    message: `${fact.stage} processing cost fact recorded.`,
    projectId,
    clipId,
    jobId,
    exportJobId,
    // Keep the metadata copy for pre-Wave readers. OperationalEvent.clipId is the indexed source.
    metadata: { ...fact, clipId: clipId ?? null },
  });
}

/**
 * Records a COGS fact without letting a telemetry failure change the outcome of real work.
 *
 * Failing the job instead is strictly worse for cost truth: the fact is lost either way, the
 * customer loses completed work, and the retry spends real money again on calls whose facts can
 * fail again. The gap stays countable as one `cost_fact_record_failed` warning event, and Gate A
 * refuses any cost-truth report whose window contains one.
 */
export async function recordProcessingCostFactSafely(
  client: OperationalEventClient | PrismaClient,
  input: RecordProcessingCostFactInput,
): Promise<void> {
  try {
    await recordProcessingCostFact(client, input);
  } catch (error) {
    await recordOperationalEventSafely(client, {
      workspaceId: input.workspaceId,
      category: "cost",
      eventType: "cost_fact_record_failed",
      severity: "warning",
      message: `${input.stage} cost fact could not be recorded.`,
      projectId: input.projectId,
      clipId: input.clipId,
      jobId: input.jobId,
      exportJobId: input.exportJobId,
      metadata: {
        stage: input.stage,
        provider: input.provider,
        detail: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
