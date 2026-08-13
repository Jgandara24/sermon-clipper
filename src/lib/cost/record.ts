import type { PrismaClient } from "@prisma/client";
import {
  recordOperationalEvent,
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
