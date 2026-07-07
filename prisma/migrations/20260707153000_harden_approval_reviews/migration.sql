-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('email', 'sms');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- AlterTable
ALTER TABLE "clip_approvals" ADD COLUMN "review_token_expires_at" TIMESTAMP(3);
ALTER TABLE "clip_approvals" ADD COLUMN "review_token_revoked_at" TIMESTAMP(3);
ALTER TABLE "clip_approvals" ADD COLUMN "review_token_last_viewed_at" TIMESTAMP(3);

UPDATE "clip_approvals"
SET "review_token_expires_at" = COALESCE("decided_at", "created_at") + INTERVAL '14 days'
WHERE "review_token_expires_at" IS NULL;

ALTER TABLE "clip_approvals" ALTER COLUMN "review_token_expires_at" SET NOT NULL;

-- CreateTable
CREATE TABLE "approval_notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "approval_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "provider_message_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clip_approval_audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "approval_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_approval_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clip_approvals_review_token_expires_at_idx" ON "clip_approvals"("review_token_expires_at");

-- CreateIndex
CREATE INDEX "approval_notifications_approval_id_idx" ON "approval_notifications"("approval_id");

-- CreateIndex
CREATE INDEX "approval_notifications_workspace_id_idx" ON "approval_notifications"("workspace_id");

-- CreateIndex
CREATE INDEX "approval_notifications_status_idx" ON "approval_notifications"("status");

-- CreateIndex
CREATE INDEX "clip_approval_audit_events_approval_id_idx" ON "clip_approval_audit_events"("approval_id");

-- CreateIndex
CREATE INDEX "clip_approval_audit_events_workspace_id_idx" ON "clip_approval_audit_events"("workspace_id");

-- CreateIndex
CREATE INDEX "clip_approval_audit_events_event_type_idx" ON "clip_approval_audit_events"("event_type");

-- AddForeignKey
ALTER TABLE "approval_notifications" ADD CONSTRAINT "approval_notifications_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "clip_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_notifications" ADD CONSTRAINT "approval_notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_approval_audit_events" ADD CONSTRAINT "clip_approval_audit_events_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "clip_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_approval_audit_events" ADD CONSTRAINT "clip_approval_audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
