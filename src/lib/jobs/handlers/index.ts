import { ProcessingJobType } from "@prisma/client";
import type { JobHandler } from "@/lib/jobs/types";
import { runFinalizeJob } from "./finalize";
import { runProbeJob } from "./probe";
import { runTranscribeJob } from "./transcribe";

export const jobHandlers: Partial<Record<ProcessingJobType, JobHandler>> = {
  [ProcessingJobType.FINALIZE]: runFinalizeJob,
  [ProcessingJobType.PROBE]: runProbeJob,
  [ProcessingJobType.TRANSCRIBE]: runTranscribeJob,
};
