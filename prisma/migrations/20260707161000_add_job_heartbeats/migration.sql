-- AlterTable
ALTER TABLE "processing_jobs" ADD COLUMN "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "processing_jobs" ADD COLUMN "worker_id" TEXT;
ALTER TABLE "processing_jobs" ADD COLUMN "heartbeat_at" TIMESTAMP(3);
ALTER TABLE "processing_jobs" ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "processing_jobs" ADD COLUMN "last_error_at" TIMESTAMP(3);
ALTER TABLE "processing_jobs" ADD COLUMN "stale_recovered_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "export_jobs" ADD COLUMN "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "export_jobs" ADD COLUMN "worker_id" TEXT;
ALTER TABLE "export_jobs" ADD COLUMN "heartbeat_at" TIMESTAMP(3);
ALTER TABLE "export_jobs" ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "export_jobs" ADD COLUMN "last_error_at" TIMESTAMP(3);
ALTER TABLE "export_jobs" ADD COLUMN "stale_recovered_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "processing_jobs_state_heartbeat_at_idx" ON "processing_jobs"("state", "heartbeat_at");

-- CreateIndex
CREATE INDEX "processing_jobs_state_type_run_after_idx" ON "processing_jobs"("state", "type", "run_after");

-- CreateIndex
CREATE INDEX "export_jobs_state_heartbeat_at_idx" ON "export_jobs"("state", "heartbeat_at");

-- CreateIndex
CREATE INDEX "export_jobs_state_run_after_idx" ON "export_jobs"("state", "run_after");
