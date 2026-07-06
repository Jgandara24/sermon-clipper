-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Enable UUID defaults.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "auth_provider" AS ENUM ('dev', 'email_otp', 'google');

-- CreateEnum
CREATE TYPE "workspace_role" AS ENUM ('owner', 'admin', 'editor', 'approver', 'viewer');

-- CreateEnum
CREATE TYPE "member_status" AS ENUM ('active', 'invited');

-- CreateEnum
CREATE TYPE "source_origin" AS ENUM ('upload', 'url');

-- CreateEnum
CREATE TYPE "project_status" AS ENUM ('draft', 'queued', 'processing', 'ready', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "processing_job_type" AS ENUM ('finalize', 'probe', 'transcribe', 'analyze', 'generate_clips', 'preview_render', 'export', 'cleanup');

-- CreateEnum
CREATE TYPE "processing_job_state" AS ENUM ('queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'retrying', 'expired');

-- CreateEnum
CREATE TYPE "ledger_kind" AS ENUM ('grant', 'processing', 'export', 'refund', 'adjustment');

-- CreateEnum
CREATE TYPE "generated_clip_status" AS ENUM ('suggested', 'kept', 'hidden');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT,
    "auth_provider" "auth_provider" NOT NULL DEFAULT 'dev',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "plan_code" TEXT NOT NULL DEFAULT 'free',
    "minute_balance" INTEGER NOT NULL DEFAULT 60,
    "storage_used_bytes" BIGINT NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "external_refs" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "workspace_role" NOT NULL,
    "status" "member_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_videos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "origin" "source_origin" NOT NULL,
    "origin_url" TEXT,
    "filename" TEXT,
    "duration_s" DECIMAL(10,2),
    "size_bytes" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "fps" DECIMAL(8,3),
    "storage_key" TEXT,
    "audio_key" TEXT,
    "thumbnail_key" TEXT,
    "language" TEXT,
    "srt_override_key" TEXT,
    "copyright_ack_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source_video_id" UUID,
    "status" "project_status" NOT NULL DEFAULT 'draft',
    "processing_config" JSONB NOT NULL DEFAULT '{}',
    "folder" TEXT,
    "series" TEXT,
    "speaker" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "type" "processing_job_type" NOT NULL,
    "state" "processing_job_state" NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message_user" TEXT,
    "minutes_reserved" DECIMAL(10,2),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_ledger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "kind" "ledger_kind" NOT NULL,
    "project_id" UUID,
    "minutes_delta" DECIMAL(10,2) NOT NULL,
    "balance_after" DECIMAL(10,2) NOT NULL,
    "job_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_clips" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "hook_text" TEXT,
    "summary" TEXT NOT NULL,
    "status" "generated_clip_status" NOT NULL DEFAULT 'suggested',
    "liked" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generated_clips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clip_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "clip_id" UUID NOT NULL,
    "total" INTEGER NOT NULL,
    "subscores" JSONB NOT NULL,
    "model_version" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clip_scores_pkey" PRIMARY KEY ("id")
);

-- AddCheckConstraints
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_minute_balance_nonnegative_chk" CHECK ("minute_balance" >= 0);
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_storage_used_bytes_nonnegative_chk" CHECK ("storage_used_bytes" >= 0);
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_progress_range_chk" CHECK ("progress" >= 0 AND "progress" <= 100);
ALTER TABLE "generated_clips" ADD CONSTRAINT "generated_clips_start_before_end_chk" CHECK ("start_ms" < "end_ms");
ALTER TABLE "clip_scores" ADD CONSTRAINT "clip_scores_total_range_chk" CHECK ("total" >= 0 AND "total" <= 100);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "workspaces_owner_id_idx" ON "workspaces"("owner_id");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "source_videos_workspace_id_idx" ON "source_videos"("workspace_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_idx" ON "projects"("workspace_id");

-- CreateIndex
CREATE INDEX "projects_source_video_id_idx" ON "projects"("source_video_id");

-- CreateIndex
CREATE UNIQUE INDEX "processing_jobs_idempotency_key_key" ON "processing_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "processing_jobs_state_type_idx" ON "processing_jobs"("state", "type");

-- CreateIndex
CREATE INDEX "processing_jobs_project_id_idx" ON "processing_jobs"("project_id");

-- CreateIndex
CREATE INDEX "usage_ledger_workspace_id_created_at_idx" ON "usage_ledger"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "usage_ledger_project_id_idx" ON "usage_ledger"("project_id");

-- CreateIndex
CREATE INDEX "generated_clips_workspace_id_idx" ON "generated_clips"("workspace_id");

-- CreateIndex
CREATE INDEX "generated_clips_project_id_idx" ON "generated_clips"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "generated_clips_project_id_rank_key" ON "generated_clips"("project_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "clip_scores_clip_id_key" ON "clip_scores"("clip_id");

-- CreateIndex
CREATE INDEX "clip_scores_workspace_id_idx" ON "clip_scores"("workspace_id");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_videos" ADD CONSTRAINT "source_videos_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_video_id_fkey" FOREIGN KEY ("source_video_id") REFERENCES "source_videos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_clips" ADD CONSTRAINT "generated_clips_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_clips" ADD CONSTRAINT "generated_clips_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_scores" ADD CONSTRAINT "clip_scores_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_scores" ADD CONSTRAINT "clip_scores_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "generated_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
