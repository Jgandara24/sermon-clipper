-- CreateEnum
CREATE TYPE "schedule_publish_status" AS ENUM ('not_started', 'in_progress', 'succeeded', 'failed');

-- AlterTable
ALTER TABLE "scheduled_posts" ADD COLUMN "publish_status" "schedule_publish_status" NOT NULL DEFAULT 'not_started',
ADD COLUMN "facebook_post_id" TEXT,
ADD COLUMN "published_at" TIMESTAMP(3),
ADD COLUMN "last_error_message" TEXT;

-- CreateIndex
CREATE INDEX "scheduled_posts_publish_status_scheduled_date_idx" ON "scheduled_posts"("publish_status", "scheduled_date");
