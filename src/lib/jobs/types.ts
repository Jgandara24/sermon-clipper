import type { PrismaClient, ProcessingJob } from "@prisma/client";

export type JobContext = {
  job: ProcessingJob;
  prisma: PrismaClient;
};

export type JobHandler = (context: JobContext) => Promise<void>;

/** Thrown by a handler to attach a user-facing error code/message (see guide §20). */
export class JobFailureError extends Error {
  code: string;
  userMessage: string;

  constructor(code: string, userMessage: string, options?: { cause?: unknown }) {
    super(userMessage);
    this.code = code;
    this.userMessage = userMessage;
    if (options?.cause) {
      this.cause = options.cause;
    }
  }
}
