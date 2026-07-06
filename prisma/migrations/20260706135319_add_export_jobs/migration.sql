-- CreateEnum
CREATE TYPE "export_preset" AS ENUM ('mp4_1080');

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clip_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "preset" "export_preset" NOT NULL DEFAULT 'mp4_1080',
    "state" "processing_job_state" NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message_user" TEXT,
    "minutes_charged" DECIMAL(10,2),
    "output_file_id" UUID,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exported_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "storage_key" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "download_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exported_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "export_jobs_idempotency_key_key" ON "export_jobs"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "export_jobs_output_file_id_key" ON "export_jobs"("output_file_id");

-- CreateIndex
CREATE INDEX "export_jobs_workspace_id_created_at_idx" ON "export_jobs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "export_jobs_clip_id_idx" ON "export_jobs"("clip_id");

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "generated_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_output_file_id_fkey" FOREIGN KEY ("output_file_id") REFERENCES "exported_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
