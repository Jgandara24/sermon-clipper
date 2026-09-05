-- Wave 2 is purely additive: new enums, new tables, and two new nullable columns on `users`.
-- No existing column changes type, loses a default, or becomes NOT NULL, so web and worker code
-- from before this migration keeps running against the migrated database. Deploy web first.

-- NOTE: Prisma also generated statements that drop transcripts_search_vector_idx, drop the
-- default on the generated transcripts.search_vector column, and re-set the identical
-- workspaces.trial_ends_at default. All three are intentionally removed: the first two would
-- destroy the raw-SQL generated column added in 20260706075745_add_transcripts, and the third is
-- a no-op Prisma re-emits because it cannot compare dbgenerated defaults. See DECISIONS.md.

-- CreateEnum
CREATE TYPE "reviewer_kind" AS ENUM ('human', 'agent');

-- CreateEnum
CREATE TYPE "clip_review_decision" AS ENUM ('accept', 'revise', 'replace');

-- CreateEnum
CREATE TYPE "review_feedback_category" AS ENUM ('content', 'forbidden_content', 'boundary', 'visual_crop', 'caption', 'audio_level', 'title_hook');

-- CreateEnum
CREATE TYPE "review_feedback_severity" AS ENUM ('blocker', 'major', 'minor', 'info');

-- CreateEnum
CREATE TYPE "review_feedback_actionability" AS ENUM ('revisable', 'replace_only', 'informational');

-- CreateEnum
CREATE TYPE "editorial_program_state" AS ENUM ('not_started', 'active', 'paused', 'completed');

-- CreateEnum
CREATE TYPE "editorial_cohort" AS ENUM ('human_only', 'assisted', 'agent_led');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_platform_operator" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "platform_operator_granted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "clip_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "scheduled_post_id" UUID,
    "clip_id" UUID,
    "export_job_id" UUID,
    "replacement_clip_id" UUID,
    "replacement_export_id" UUID,
    "reviewer_user_id" UUID,
    "reviewer_kind" "reviewer_kind" NOT NULL DEFAULT 'human',
    "decision" "clip_review_decision" NOT NULL,
    "project_id_snapshot" UUID NOT NULL,
    "scheduled_post_id_snapshot" UUID NOT NULL,
    "clip_id_snapshot" UUID NOT NULL,
    "clip_rank" INTEGER NOT NULL,
    "clip_start_ms" INTEGER NOT NULL,
    "clip_end_ms" INTEGER NOT NULL,
    "export_job_id_snapshot" UUID NOT NULL,
    "edit_version" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "replacement_clip_id_snapshot" UUID,
    "replacement_clip_rank" INTEGER,
    "replacement_clip_start_ms" INTEGER,
    "replacement_clip_end_ms" INTEGER,
    "replacement_export_job_id_snapshot" UUID,
    "slot_snapshot" JSONB NOT NULL DEFAULT '{}',
    "note" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clip_review_feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clip_review_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "category" "review_feedback_category" NOT NULL,
    "severity" "review_feedback_severity" NOT NULL DEFAULT 'major',
    "actionability" "review_feedback_actionability" NOT NULL,
    "note" TEXT NOT NULL,
    "start_ms" INTEGER,
    "end_ms" INTEGER,
    "author_kind" "reviewer_kind" NOT NULL DEFAULT 'human',
    "author_user_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_review_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_programs" (
    "key" TEXT NOT NULL,
    "state" "editorial_program_state" NOT NULL DEFAULT 'not_started',
    "minimum_days" INTEGER NOT NULL DEFAULT 30,
    "started_at" TIMESTAMP(3),
    "started_by_user_id" UUID,
    "paused_at" TIMESTAMP(3),
    "paused_ms" BIGINT NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMP(3),
    "completed_by_user_id" UUID,
    "start_evidence" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "editorial_programs_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "editorial_program_workspaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "program_key" TEXT NOT NULL,
    "workspace_id" UUID NOT NULL,
    "cohort" "editorial_cohort" NOT NULL DEFAULT 'human_only',
    "promoted_at" TIMESTAMP(3),
    "promoted_by_user_id" UUID,
    "rolled_back_at" TIMESTAMP(3),
    "rolled_back_by_user_id" UUID,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "editorial_program_workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clip_reviews_workspace_id_created_at_idx" ON "clip_reviews"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "clip_reviews_scheduled_post_id_snapshot_created_at_idx" ON "clip_reviews"("scheduled_post_id_snapshot", "created_at");

-- CreateIndex
CREATE INDEX "clip_reviews_export_job_id_snapshot_decision_created_at_idx" ON "clip_reviews"("export_job_id_snapshot", "decision", "created_at");

-- CreateIndex
CREATE INDEX "clip_reviews_clip_id_snapshot_created_at_idx" ON "clip_reviews"("clip_id_snapshot", "created_at");

-- CreateIndex
CREATE INDEX "clip_reviews_decision_created_at_idx" ON "clip_reviews"("decision", "created_at");

-- CreateIndex
CREATE INDEX "clip_reviews_project_id_idx" ON "clip_reviews"("project_id");

-- CreateIndex
CREATE INDEX "clip_reviews_scheduled_post_id_idx" ON "clip_reviews"("scheduled_post_id");

-- CreateIndex
CREATE INDEX "clip_reviews_clip_id_idx" ON "clip_reviews"("clip_id");

-- CreateIndex
CREATE INDEX "clip_reviews_export_job_id_idx" ON "clip_reviews"("export_job_id");

-- CreateIndex
CREATE INDEX "clip_reviews_replacement_clip_id_idx" ON "clip_reviews"("replacement_clip_id");

-- CreateIndex
CREATE INDEX "clip_reviews_replacement_export_id_idx" ON "clip_reviews"("replacement_export_id");

-- CreateIndex
CREATE INDEX "clip_reviews_reviewer_user_id_idx" ON "clip_reviews"("reviewer_user_id");

-- CreateIndex
CREATE INDEX "clip_review_feedback_clip_review_id_created_at_idx" ON "clip_review_feedback"("clip_review_id", "created_at");

-- CreateIndex
CREATE INDEX "clip_review_feedback_workspace_id_created_at_idx" ON "clip_review_feedback"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "clip_review_feedback_category_created_at_idx" ON "clip_review_feedback"("category", "created_at");

-- CreateIndex
CREATE INDEX "clip_review_feedback_actionability_created_at_idx" ON "clip_review_feedback"("actionability", "created_at");

-- CreateIndex
CREATE INDEX "clip_review_feedback_author_user_id_idx" ON "clip_review_feedback"("author_user_id");

-- CreateIndex
CREATE INDEX "editorial_programs_state_idx" ON "editorial_programs"("state");

-- CreateIndex
CREATE INDEX "editorial_programs_started_by_user_id_idx" ON "editorial_programs"("started_by_user_id");

-- CreateIndex
CREATE INDEX "editorial_programs_completed_by_user_id_idx" ON "editorial_programs"("completed_by_user_id");

-- CreateIndex
CREATE INDEX "editorial_program_workspaces_workspace_id_idx" ON "editorial_program_workspaces"("workspace_id");

-- CreateIndex
CREATE INDEX "editorial_program_workspaces_cohort_idx" ON "editorial_program_workspaces"("cohort");

-- CreateIndex
CREATE INDEX "editorial_program_workspaces_promoted_by_user_id_idx" ON "editorial_program_workspaces"("promoted_by_user_id");

-- CreateIndex
CREATE INDEX "editorial_program_workspaces_rolled_back_by_user_id_idx" ON "editorial_program_workspaces"("rolled_back_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "editorial_program_workspaces_program_key_workspace_id_key" ON "editorial_program_workspaces"("program_key", "workspace_id");

-- CreateIndex
CREATE INDEX "users_is_platform_operator_idx" ON "users"("is_platform_operator");

-- AddForeignKey
ALTER TABLE "clip_reviews" ADD CONSTRAINT "clip_reviews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_reviews" ADD CONSTRAINT "clip_reviews_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_reviews" ADD CONSTRAINT "clip_reviews_scheduled_post_id_fkey" FOREIGN KEY ("scheduled_post_id") REFERENCES "scheduled_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_reviews" ADD CONSTRAINT "clip_reviews_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "generated_clips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_reviews" ADD CONSTRAINT "clip_reviews_export_job_id_fkey" FOREIGN KEY ("export_job_id") REFERENCES "export_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_reviews" ADD CONSTRAINT "clip_reviews_replacement_clip_id_fkey" FOREIGN KEY ("replacement_clip_id") REFERENCES "generated_clips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_reviews" ADD CONSTRAINT "clip_reviews_replacement_export_id_fkey" FOREIGN KEY ("replacement_export_id") REFERENCES "export_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_reviews" ADD CONSTRAINT "clip_reviews_reviewer_user_id_fkey" FOREIGN KEY ("reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_review_feedback" ADD CONSTRAINT "clip_review_feedback_clip_review_id_fkey" FOREIGN KEY ("clip_review_id") REFERENCES "clip_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_review_feedback" ADD CONSTRAINT "clip_review_feedback_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_review_feedback" ADD CONSTRAINT "clip_review_feedback_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_programs" ADD CONSTRAINT "editorial_programs_started_by_user_id_fkey" FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_programs" ADD CONSTRAINT "editorial_programs_completed_by_user_id_fkey" FOREIGN KEY ("completed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_program_workspaces" ADD CONSTRAINT "editorial_program_workspaces_program_key_fkey" FOREIGN KEY ("program_key") REFERENCES "editorial_programs"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_program_workspaces" ADD CONSTRAINT "editorial_program_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_program_workspaces" ADD CONSTRAINT "editorial_program_workspaces_promoted_by_user_id_fkey" FOREIGN KEY ("promoted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_program_workspaces" ADD CONSTRAINT "editorial_program_workspaces_rolled_back_by_user_id_fkey" FOREIGN KEY ("rolled_back_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Append-only editorial evidence.
--
-- A recorded decision is corrected by appending a newer one, never by rewriting the old row.
-- The trigger refuses every UPDATE with one exemption: a referential SET NULL that clears a live
-- foreign key when the clip, export, slot, or user it points at is deleted. Each nullable live
-- link is passed as a trigger argument; clearing one is allowed, changing one to a different
-- value is not, and no other column may move.
--
-- DELETE is deliberately NOT blocked. These rows carry `ON DELETE CASCADE` from `workspaces`, and
-- a trigger that refused the cascade would make workspace teardown fail with an error nobody can
-- act on. Erasure is therefore bounded by deleting the whole tenant, which is not a product
-- feature today. The guarantee this trigger makes is that a decision cannot be silently altered.
CREATE OR REPLACE FUNCTION editorial_evidence_is_append_only()
RETURNS TRIGGER AS $$
DECLARE
  live_link TEXT;
  old_body  JSONB := to_jsonb(OLD);
  new_body  JSONB := to_jsonb(NEW);
BEGIN
  FOREACH live_link IN ARRAY TG_ARGV LOOP
    IF (old_body -> live_link) IS DISTINCT FROM (new_body -> live_link)
       AND jsonb_typeof(new_body -> live_link) <> 'null' THEN
      RAISE EXCEPTION
        'append-only: %.% may only be cleared by a referential SET NULL, never rewritten (id %)',
        TG_TABLE_NAME, live_link, OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    old_body := old_body - live_link;
    new_body := new_body - live_link;
  END LOOP;

  IF old_body IS DISTINCT FROM new_body THEN
    RAISE EXCEPTION
      'append-only: % rows cannot be updated; append a newer row instead (id %)',
      TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clip_reviews_append_only
BEFORE UPDATE ON "clip_reviews"
FOR EACH ROW
EXECUTE FUNCTION editorial_evidence_is_append_only(
  'project_id', 'scheduled_post_id', 'clip_id', 'export_job_id',
  'replacement_clip_id', 'replacement_export_id', 'reviewer_user_id'
);

CREATE TRIGGER clip_review_feedback_append_only
BEFORE UPDATE ON "clip_review_feedback"
FOR EACH ROW
EXECUTE FUNCTION editorial_evidence_is_append_only('author_user_id');

-- The one human-reference program row. Created here so P2.9's start command only ever moves an
-- existing row's state and can never race two programs into existence.
INSERT INTO "editorial_programs" ("key", "state", "minimum_days", "created_at", "updated_at")
VALUES ('human_reference', 'not_started', 30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
