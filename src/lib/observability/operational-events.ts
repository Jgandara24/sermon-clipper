import type { Prisma, PrismaClient } from "@prisma/client";

type OperationalEventClient = PrismaClient | Prisma.TransactionClient;

export type OperationalEventSeverity = "info" | "warning" | "error";
export type OperationalEventCategory =
  | "upload"
  | "processing"
  | "transcription"
  | "analysis"
  | "export"
  | "approval"
  | "billing"
  | "worker";

export type OperationalEventInput = {
  workspaceId?: string | null;
  category: OperationalEventCategory;
  eventType: string;
  severity?: OperationalEventSeverity;
  message: string;
  projectId?: string | null;
  jobId?: string | null;
  exportJobId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export async function recordOperationalEvent(
  client: OperationalEventClient,
  input: OperationalEventInput,
) {
  return client.operationalEvent.create({
    data: {
      workspaceId: input.workspaceId ?? undefined,
      category: input.category,
      eventType: input.eventType,
      severity: input.severity ?? "info",
      message: input.message,
      projectId: input.projectId ?? undefined,
      jobId: input.jobId ?? undefined,
      exportJobId: input.exportJobId ?? undefined,
      metadata: input.metadata ?? {},
    },
  });
}

export async function recordOperationalEventSafely(
  client: OperationalEventClient,
  input: OperationalEventInput,
) {
  try {
    return await recordOperationalEvent(client, input);
  } catch (error) {
    console.error("[observability] failed to record operational event", error);
    return null;
  }
}
