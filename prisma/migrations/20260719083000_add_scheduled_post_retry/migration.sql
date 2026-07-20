-- Transient Facebook publish failures re-queue with backoff instead of failing terminally.
ALTER TABLE "scheduled_posts" ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "scheduled_posts" ADD COLUMN "next_attempt_at" TIMESTAMP(3);
