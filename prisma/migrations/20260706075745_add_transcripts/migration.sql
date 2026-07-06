-- CreateTable
CREATE TABLE "transcripts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_video_id" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "full_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_segments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "transcript_id" UUID NOT NULL,
    "idx" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "speaker_label" TEXT,
    "words" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_source_video_id_key" ON "transcripts"("source_video_id");

-- CreateIndex
CREATE INDEX "transcript_segments_transcript_id_start_ms_idx" ON "transcript_segments"("transcript_id", "start_ms");

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_source_video_id_fkey" FOREIGN KEY ("source_video_id") REFERENCES "source_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Full-text search (guide §6: "full_text tsvector-indexed"). Generated column stays in sync with
-- full_text automatically; Prisma models it only as an untyped Unsupported field.
ALTER TABLE "transcripts" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "full_text")) STORED;
CREATE INDEX "transcripts_search_vector_idx" ON "transcripts" USING GIN ("search_vector");
