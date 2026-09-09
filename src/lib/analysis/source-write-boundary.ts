import { Prisma } from "@prisma/client";
import { JobFailureError } from "@/lib/jobs/types";

export const CLIP_TRANSCRIPT_CHANGED = "CLIP_TRANSCRIPT_CHANGED";
export const CLIP_TRANSCRIPT_CHANGED_MESSAGE =
  "This clip's transcript changed or the clip was replaced. Open the current clip before trying again.";

/** Safe message for route and coordinator callers; never surface the database error text. */
export class ClipTranscriptChangedError extends Error {
  constructor() {
    super(CLIP_TRANSCRIPT_CHANGED_MESSAGE);
  }
}

/** Prisma 6 exposes the raised check as an unknown query error, without the constraint name. */
export function isClipTranscriptChanged(error: unknown): boolean {
  return error instanceof ClipTranscriptChangedError ||
    (error instanceof Prisma.PrismaClientUnknownRequestError &&
      error.message.includes('code: "23514"') &&
      error.message.includes(`message: "${CLIP_TRANSCRIPT_CHANGED}"`));
}

export function transcriptChangedError() {
  return new JobFailureError("TRANSCRIPT_CHANGED",
    "This sermon's source or transcript changed during processing. Refresh before trying again.",
    { retryable: false, preservesProject: true });
}
