-- CreateTable
CREATE TABLE "clip_edits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clip_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "editor_state" JSONB NOT NULL,
    "is_autosave" BOOLEAN NOT NULL DEFAULT false,
    "saved_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clip_edits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clip_edits_clip_id_version_key" ON "clip_edits"("clip_id", "version");

-- AddForeignKey
ALTER TABLE "clip_edits" ADD CONSTRAINT "clip_edits_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "generated_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_edits" ADD CONSTRAINT "clip_edits_saved_by_fkey" FOREIGN KEY ("saved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
