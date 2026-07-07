-- CreateTable
CREATE TABLE "scripture_references" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "clip_id" UUID,
    "detected_text" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "book" TEXT NOT NULL,
    "chapter_start" INTEGER NOT NULL,
    "verse_start" INTEGER,
    "chapter_end" INTEGER,
    "verse_end" INTEGER,
    "confidence" DECIMAL(4,2) NOT NULL DEFAULT 0.80,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scripture_references_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scripture_references_workspace_id_idx" ON "scripture_references"("workspace_id");

-- CreateIndex
CREATE INDEX "scripture_references_project_id_idx" ON "scripture_references"("project_id");

-- CreateIndex
CREATE INDEX "scripture_references_clip_id_idx" ON "scripture_references"("clip_id");

-- AddForeignKey
ALTER TABLE "scripture_references" ADD CONSTRAINT "scripture_references_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripture_references" ADD CONSTRAINT "scripture_references_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripture_references" ADD CONSTRAINT "scripture_references_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "generated_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
