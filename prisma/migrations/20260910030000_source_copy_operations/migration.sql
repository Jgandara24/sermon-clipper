CREATE TABLE "source_copy_operations" (
  "id" UUID PRIMARY KEY,
  "plan_hash" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "source_video_id" UUID NOT NULL UNIQUE,
  "storage_key" TEXT NOT NULL UNIQUE,
  "state" TEXT NOT NULL DEFAULT 'PREPARED' CHECK ("state" IN ('PREPARED', 'COMPLETE')),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ,
  "retain_until" TIMESTAMPTZ NOT NULL
);
