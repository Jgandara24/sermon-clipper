-- CreateEnum
CREATE TYPE "clip_approval_state" AS ENUM ('draft', 'in_review', 'approved', 'changes_requested');

-- CreateTable
CREATE TABLE "brand_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "church_name" TEXT NOT NULL,
    "speaker_name" TEXT,
    "primary_color" TEXT NOT NULL DEFAULT '#0f766e',
    "accent_color" TEXT NOT NULL DEFAULT '#facc15',
    "caption_preset_id" TEXT NOT NULL DEFAULT 'clean',
    "lower_third" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clip_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "clip_id" UUID NOT NULL,
    "state" "clip_approval_state" NOT NULL DEFAULT 'draft',
    "review_token" TEXT NOT NULL,
    "requester_id" UUID,
    "approver_name" TEXT,
    "comment" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clip_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brand_templates_workspace_id_idx" ON "brand_templates"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "clip_approvals_review_token_key" ON "clip_approvals"("review_token");

-- CreateIndex
CREATE UNIQUE INDEX "clip_approvals_clip_id_key" ON "clip_approvals"("clip_id");

-- CreateIndex
CREATE INDEX "clip_approvals_workspace_id_idx" ON "clip_approvals"("workspace_id");

-- AddForeignKey
ALTER TABLE "brand_templates" ADD CONSTRAINT "brand_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_approvals" ADD CONSTRAINT "clip_approvals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_approvals" ADD CONSTRAINT "clip_approvals_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "generated_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_approvals" ADD CONSTRAINT "clip_approvals_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
