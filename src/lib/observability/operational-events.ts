import type { Prisma, PrismaClient } from "@prisma/client";

type OperationalEventClient = PrismaClient | Prisma.TransactionClient;

export type OperationalEventSeverity = "info" | "warning" | "error";
export type OperationalEventCategory =
  | "auth"
  | "upload"
  | "processing"
  | "transcription"
  | "analysis"
  | "export"
  | "approval"
  | "billing"
  | "worker"
  | "channel_import";

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
  const event = await client.operationalEvent.create({
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

  if ((input.severity ?? "info") === "error") {
    // Fire-and-forget so alert delivery never extends a transaction or fails the caller.
    const { dispatchOperationalAlertSafely } = await import("@/lib/observability/alerts");
    void dispatchOperationalAlertSafely(input);
  }

  return event;
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
