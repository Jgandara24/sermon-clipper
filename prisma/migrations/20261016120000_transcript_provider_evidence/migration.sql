-- Preserve provider clocks and audio events separately from display-normalized words.
ALTER TABLE "transcripts" ADD COLUMN "provider_evidence" JSONB;
