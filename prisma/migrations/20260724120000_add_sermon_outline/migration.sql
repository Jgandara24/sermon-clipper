-- CreateEnum
CREATE TYPE "sermon_outline_status" AS ENUM ('generated', 'heuristic', 'fallback_single');

-- CreateEnum
CREATE TYPE "sermon_section_type" AS ENUM ('introduction', 'point', 'conclusion', 'main_message');

-- AlterTable
ALTER TABLE "generated_clips" ADD COLUMN     "section_id" UUID;

-- CreateTable
CREATE TABLE "sermon_outlines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "main_idea" TEXT NOT NULL,
    "generated_title" TEXT,
    "model_version" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "sermon_outline_status" NOT NULL,
    "exclusions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sermon_outlines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sermon_sections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "outline_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "sermon_section_type" NOT NULL,
    "heading" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "start_segment_idx" INTEGER NOT NULL,
    "end_segment_idx" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sermon_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sermon_outlines_project_id_key" ON "sermon_outlines"("project_id");

-- CreateIndex
CREATE INDEX "sermon_outlines_workspace_id_idx" ON "sermon_outlines"("workspace_id");

-- CreateIndex
CREATE INDEX "sermon_sections_outline_id_idx" ON "sermon_sections"("outline_id");

-- CreateIndex
CREATE UNIQUE INDEX "sermon_sections_outline_id_position_key" ON "sermon_sections"("outline_id", "position");

-- CreateIndex
CREATE INDEX "generated_clips_section_id_idx" ON "generated_clips"("section_id");

-- AddForeignKey
ALTER TABLE "generated_clips" ADD CONSTRAINT "generated_clips_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sermon_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sermon_outlines" ADD CONSTRAINT "sermon_outlines_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sermon_outlines" ADD CONSTRAINT "sermon_outlines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sermon_sections" ADD CONSTRAINT "sermon_sections_outline_id_fkey" FOREIGN KEY ("outline_id") REFERENCES "sermon_outlines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

