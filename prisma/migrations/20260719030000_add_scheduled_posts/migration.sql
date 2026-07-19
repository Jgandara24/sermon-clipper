-- CreateEnum
CREATE TYPE "service_slot" AS ENUM ('primary', 'secondary');

-- CreateEnum
CREATE TYPE "social_platform" AS ENUM ('facebook', 'instagram', 'tiktok', 'youtube');

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "sermon_date" DATE,
ADD COLUMN "service_slot" "service_slot" NOT NULL DEFAULT 'primary';

-- CreateTable
CREATE TABLE "scheduled_posts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "clip_id" UUID NOT NULL,
    "scheduled_date" DATE NOT NULL,
    "platform" "social_platform" NOT NULL DEFAULT 'facebook',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_posts_clip_id_key" ON "scheduled_posts"("clip_id");

-- CreateIndex
CREATE INDEX "scheduled_posts_workspace_id_scheduled_date_idx" ON "scheduled_posts"("workspace_id", "scheduled_date");

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "generated_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
