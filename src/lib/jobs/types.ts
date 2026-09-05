import type { Prisma, PrismaClient, ProcessingJob } from "@prisma/client";

export type JobContext = {
  job: ProcessingJob;
  prisma: PrismaClient;
};

export type JobSuccessMetadata = Prisma.InputJsonObject;

export type JobHandlerResult = {
  metadata?: JobSuccessMetadata;
} | void;

export type JobHandler = (context: JobContext) => Promise<JobHandlerResult>;

/** Thrown by a handler to attach a user-facing error code/message (see guide §20). */
export class JobFailureError extends Error {
  code: string;
  userMessage: string;
  retryable: boolean;
  /**
   * True when the handler refused to act and changed nothing — the project is exactly as it was,
   * so the runner must not mark it failed or release its reservations. A rebuild refused because
   * a person has already worked on the clips is the case: the clips are intact and the project
   * is healthy; only the request to replace them was declined.
   */
  preservesProject: boolean;

  constructor(
    code: string,
    userMessage: string,
    options?: { cause?: unknown; retryable?: boolean; preservesProject?: boolean },
  ) {
    super(userMessage);
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = options?.retryable ?? true;
    this.preservesProject = options?.preservesProject ?? false;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}
