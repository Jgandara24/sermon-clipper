-- Wave 1 is expand-first. Run the P0.15 collision and legacy-export audits before this migration,
-- keep automatic publishing disabled, and leave all historical identity fields nullable.

-- NOTE: Prisma also generated statements that drop transcripts_search_vector_idx and alter the
-- generated search_vector column. They are intentionally removed. See DECISIONS.md.

-- AlterTable
ALTER TABLE "export_jobs" ADD COLUMN "edit_version" INTEGER,
ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "qc_checked_at" TIMESTAMP(3),
ADD COLUMN "qc_checksum" TEXT,
ADD COLUMN "qc_details" JSONB,
ADD COLUMN "qc_status" "render_qc_status";

-- AlterTable
ALTER TABLE "generated_clips" ADD COLUMN "superseded_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "operational_events" ADD COLUMN "clip_id" UUID;

-- AlterTable
ALTER TABLE "scheduled_posts" ADD COLUMN "export_job_id" UUID,
ADD COLUMN "project_id" UUID;

-- A live clip proves project ownership. Detached historical slots stay null and fail closed.
UPDATE "scheduled_posts" AS sp
SET "project_id" = clips."project_id"
FROM "generated_clips" AS clips
WHERE sp."clip_id" = clips."id";

-- CreateTable
CREATE TABLE "daily_cost_rollups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "day" DATE NOT NULL,
    "dimension_key" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(24,9) NOT NULL DEFAULT 0,
    "total_cost_usd" DECIMAL(24,9) NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "cpu_time_ms" BIGINT NOT NULL DEFAULT 0,
    "wall_time_ms" BIGINT NOT NULL DEFAULT 0,
    "event_count" INTEGER NOT NULL DEFAULT 0,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "unpriced_event_count" INTEGER NOT NULL DEFAULT 0,
    "source_last_event_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_cost_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scheduled_post_id" UUID NOT NULL,
    "expected_clip_id" UUID,
    "expected_export_job_id" UUID,
    "state" "publish_attempt_state" NOT NULL DEFAULT 'intent',
    "provider_post_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "attempted_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publish_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_exceptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "scheduled_post_id" UUID,
    "exception_type" TEXT NOT NULL,
    "state" "editorial_exception_state" NOT NULL DEFAULT 'open',
    "message" TEXT NOT NULL,
    "project_snapshot" JSONB NOT NULL DEFAULT '{}',
    "slot_snapshot" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "resolved_at" TIMESTAMP(3),
    "resolved_by_user_id" UUID,
    "resolution_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "editorial_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_cost_rollups_workspace_id_day_idx" ON "daily_cost_rollups"("workspace_id", "day");

-- CreateIndex
CREATE INDEX "daily_cost_rollups_project_id_day_idx" ON "daily_cost_rollups"("project_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "daily_cost_rollups_workspace_id_day_dimension_key_key" ON "daily_cost_rollups"("workspace_id", "day", "dimension_key");

-- CreateIndex
CREATE INDEX "publish_attempts_scheduled_post_id_created_at_idx" ON "publish_attempts"("scheduled_post_id", "created_at");

-- CreateIndex
CREATE INDEX "publish_attempts_state_created_at_idx" ON "publish_attempts"("state", "created_at");

-- CreateIndex
CREATE INDEX "editorial_exceptions_workspace_id_state_created_at_idx" ON "editorial_exceptions"("workspace_id", "state", "created_at");

-- CreateIndex
CREATE INDEX "editorial_exceptions_project_id_idx" ON "editorial_exceptions"("project_id");

-- CreateIndex
CREATE INDEX "editorial_exceptions_scheduled_post_id_idx" ON "editorial_exceptions"("scheduled_post_id");

-- CreateIndex
CREATE INDEX "editorial_exceptions_resolved_by_user_id_idx" ON "editorial_exceptions"("resolved_by_user_id");

-- CreateIndex
CREATE INDEX "operational_events_clip_id_idx" ON "operational_events"("clip_id");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_posts_export_job_id_key" ON "scheduled_posts"("export_job_id");

-- CreateIndex
CREATE INDEX "scheduled_posts_project_id_idx" ON "scheduled_posts"("project_id");

-- One active row reserves a workspace date. MISSED is terminal and releases that date.
CREATE UNIQUE INDEX "scheduled_posts_one_non_missed_date_idx"
ON "scheduled_posts" ("workspace_id", "scheduled_date")
WHERE "publish_status" <> 'missed'::"schedule_publish_status";

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_export_job_id_fkey" FOREIGN KEY ("export_job_id") REFERENCES "export_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_cost_rollups" ADD CONSTRAINT "daily_cost_rollups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_scheduled_post_id_fkey" FOREIGN KEY ("scheduled_post_id") REFERENCES "scheduled_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_exceptions" ADD CONSTRAINT "editorial_exceptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_exceptions" ADD CONSTRAINT "editorial_exceptions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_exceptions" ADD CONSTRAINT "editorial_exceptions_scheduled_post_id_fkey" FOREIGN KEY ("scheduled_post_id") REFERENCES "scheduled_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_exceptions" ADD CONSTRAINT "editorial_exceptions_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
