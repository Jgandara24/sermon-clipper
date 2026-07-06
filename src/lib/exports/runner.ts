import { prisma } from "@/lib/prisma";
import { ExportFailureError, runExportJob } from "./handler";
import { claimNextExportJob, markExportJobFailedOrRetry, markExportJobSucceeded } from "./queue";

/** Claims and runs a single pending export job, if one is available. Returns whether it found work. */
export async function runOnePendingExportJob(): Promise<boolean> {
  const job = await claimNextExportJob(prisma);
  if (!job) {
    return false;
  }

  try {
    const outputFileId = await runExportJob(prisma, job);
    await markExportJobSucceeded(prisma, job.id, outputFileId);
  } catch (error) {
    const failure =
      error instanceof ExportFailureError
        ? { code: error.code, message: error.userMessage }
        : { code: "RENDER_FAILED", message: "Export failed on our side — your clip is safe." };

    if (!(error instanceof ExportFailureError)) {
      console.error(`[worker] export job ${job.id} failed unexpectedly`, error);
    }

    await markExportJobFailedOrRetry(prisma, job, failure);
  }

  return true;
}
