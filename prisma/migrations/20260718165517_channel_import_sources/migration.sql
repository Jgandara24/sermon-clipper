-- CreateEnum
CREATE TYPE "channel_import_platform" AS ENUM ('youtube');

-- DropIndex (stale: superseded by processing_jobs_state_type_run_after_idx in
-- 20260707161000_add_job_heartbeats, which never dropped the old two-column index)
DROP INDEX "processing_jobs_state_type_idx";

-- NOTE: prisma migrate dev also generated statements dropping transcripts_search_vector_idx and
-- the search_vector "default" — those would destroy the intentional raw-SQL generated column +
-- GIN index from 20260706075745_add_transcripts (see the comment on Transcript.searchVector in
-- schema.prisma). They were removed by hand; do not re-add them.

-- CreateTable
CREATE TABLE "channel_import_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "platform" "channel_import_platform" NOT NULL,
    "channel_id" TEXT NOT NULL,
    "channel_handle" TEXT,
    "channel_title" TEXT NOT NULL,
    "uploads_playlist_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_polled_at" TIMESTAMP(3),
    "last_poll_error_at" TIMESTAMP(3),
    "last_poll_error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_import_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_imported_videos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "channel_import_source_id" UUID NOT NULL,
    "platform_video_id" TEXT NOT NULL,
    "project_id" UUID,
    "published_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_imported_videos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_import_sources_workspace_id_idx" ON "channel_import_sources"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_import_sources_workspace_id_platform_channel_id_key" ON "channel_import_sources"("workspace_id", "platform", "channel_id");

-- CreateIndex
CREATE INDEX "channel_imported_videos_project_id_idx" ON "channel_imported_videos"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_imported_videos_channel_import_source_id_platform_v_key" ON "channel_imported_videos"("channel_import_source_id", "platform_video_id");

-- AddForeignKey
ALTER TABLE "channel_import_sources" ADD CONSTRAINT "channel_import_sources_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_imported_videos" ADD CONSTRAINT "channel_imported_videos_channel_import_source_id_fkey" FOREIGN KEY ("channel_import_source_id") REFERENCES "channel_import_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_imported_videos" ADD CONSTRAINT "channel_imported_videos_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
