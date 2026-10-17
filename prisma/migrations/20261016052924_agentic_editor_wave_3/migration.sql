-- Additive Wave 3. Preserve the generated tsvector column, its GIN index, and unrelated defaults.
BEGIN;

-- AlterTable
ALTER TABLE "transcripts" ADD COLUMN     "capabilities" JSONB,
ADD COLUMN     "provenance" JSONB;

-- CreateTable
CREATE TABLE "media_regions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_video_id" UUID NOT NULL,
    "identity_key" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "start_ms" BIGINT NOT NULL,
    "end_ms" BIGINT NOT NULL,
    "detector_version" TEXT NOT NULL,
    "configuration_sha256" TEXT NOT NULL,
    "input_sha256" TEXT NOT NULL,
    "evidence_sha256" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "slide_subtype" TEXT,
    "ocr_evidence" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "derived_media_artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_video_id" UUID NOT NULL,
    "identity_key" TEXT NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "start_ms" BIGINT NOT NULL,
    "end_ms" BIGINT NOT NULL,
    "derivation_version" TEXT NOT NULL,
    "configuration_sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_count" BIGINT NOT NULL,
    "retention_class" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "mapping_status" TEXT NOT NULL,
    "mapping_evidence_sha256" TEXT,
    "visual_quality" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deletion_evidence" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "derived_media_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_regions_identity_key_key" ON "media_regions"("identity_key");

-- CreateIndex
CREATE INDEX "media_regions_source_video_id_start_ms_end_ms_idx" ON "media_regions"("source_video_id", "start_ms", "end_ms");

-- CreateIndex
CREATE UNIQUE INDEX "derived_media_artifacts_identity_key_key" ON "derived_media_artifacts"("identity_key");

-- CreateIndex
CREATE UNIQUE INDEX "derived_media_artifacts_storage_key_key" ON "derived_media_artifacts"("storage_key");

-- CreateIndex
CREATE INDEX "derived_media_artifacts_source_video_id_kind_start_ms_end_m_idx" ON "derived_media_artifacts"("source_video_id", "kind", "start_ms", "end_ms");

-- CreateIndex
CREATE INDEX "derived_media_artifacts_expires_at_deleted_at_idx" ON "derived_media_artifacts"("expires_at", "deleted_at");

-- AddForeignKey
ALTER TABLE "media_regions" ADD CONSTRAINT "media_regions_source_video_id_fkey" FOREIGN KEY ("source_video_id") REFERENCES "source_videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "derived_media_artifacts" ADD CONSTRAINT "derived_media_artifacts_source_video_id_fkey" FOREIGN KEY ("source_video_id") REFERENCES "source_videos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE media_regions
  ADD CONSTRAINT media_region_interval CHECK (start_ms >= 0 AND end_ms > start_ms AND end_ms <= 9007199254740991),
  ADD CONSTRAINT media_region_hashes CHECK (
    identity_key ~ '^[a-f0-9]{64}$' AND source_sha256 ~ '^[a-f0-9]{64}$' AND
    configuration_sha256 ~ '^[a-f0-9]{64}$' AND input_sha256 ~ '^[a-f0-9]{64}$' AND evidence_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT media_region_confidence CHECK (confidence >= 0 AND confidence <= 1),
  ADD CONSTRAINT media_region_detector CHECK (length(btrim(detector_version)) > 0),
  ADD CONSTRAINT media_region_kind CHECK (kind IN ('SERMON','WORSHIP','ANNOUNCEMENT','PRAYER','BAPTISM','ALTAR_CALL',
    'OTHER_SERVICE_CONTENT','PASTOR_VISIBLE','FULLSCREEN_SLIDE','VERSE_SLIDESHOW','AMBIGUOUS')),
  ADD CONSTRAINT media_region_slide CHECK (
    (kind = 'FULLSCREEN_SLIDE' AND slide_subtype IS NOT NULL AND slide_subtype IN
      ('SCRIPTURE','SERMON_TITLE','MAIN_POINT','SUBPOINT','NUMBERED_POINT','SECTION_TRANSITION','OTHER_PRESENTATION')) OR
    (kind <> 'FULLSCREEN_SLIDE' AND slide_subtype IS NULL));

ALTER TABLE derived_media_artifacts
  ADD CONSTRAINT media_artifact_interval CHECK (start_ms >= 0 AND end_ms > start_ms AND end_ms <= 9007199254740991),
  ADD CONSTRAINT media_artifact_hashes CHECK (
    identity_key ~ '^[a-f0-9]{64}$' AND source_sha256 ~ '^[a-f0-9]{64}$' AND
    configuration_sha256 ~ '^[a-f0-9]{64}$' AND sha256 ~ '^[a-f0-9]{64}$' AND
    (mapping_evidence_sha256 IS NULL OR mapping_evidence_sha256 ~ '^[a-f0-9]{64}$')),
  ADD CONSTRAINT media_artifact_bytes CHECK (byte_count > 0),
  ADD CONSTRAINT media_artifact_version CHECK (length(btrim(derivation_version)) > 0),
  ADD CONSTRAINT media_artifact_storage_key CHECK (length(btrim(storage_key)) > 0),
  ADD CONSTRAINT media_artifact_kind CHECK (kind IN ('ANALYSIS_AUDIO','SOURCE_PROXY','SPARSE_FRAME','TIMELINE_VIEW',
    'BOUNDARY_STRIP','SERMON_AUDIO','CANDIDATE_RANGE','WAVEFORM')),
  ADD CONSTRAINT media_artifact_retention CHECK (retention_class IN ('ANALYSIS','PREVIEW','RENDER_SOURCE') AND
    (kind <> 'CANDIDATE_RANGE' OR retention_class = 'RENDER_SOURCE')),
  ADD CONSTRAINT media_artifact_mapping CHECK (mapping_status IN ('DECLARED','VERIFIED','FAILED') AND
    (mapping_status <> 'VERIFIED' OR mapping_evidence_sha256 IS NOT NULL)),
  ADD CONSTRAINT media_artifact_quality CHECK (visual_quality IN ('NOT_REVIEWED','ACCEPTED','REJECTED','NOT_APPLICABLE') AND
    (kind <> 'CANDIDATE_RANGE' OR visual_quality <> 'NOT_APPLICABLE')),
  ADD CONSTRAINT media_artifact_deletion CHECK (
    (deleted_at IS NULL AND deletion_evidence IS NULL) OR
    (deleted_at IS NOT NULL AND deletion_evidence IS NOT NULL AND jsonb_typeof(deletion_evidence) = 'object'
      AND deletion_evidence <> '{}'::jsonb));

ALTER TABLE transcripts ADD CONSTRAINT transcript_provenance_pair CHECK (
  (capabilities IS NULL AND provenance IS NULL) OR
  (capabilities IS NOT NULL AND provenance IS NOT NULL AND jsonb_typeof(capabilities) = 'object'
    AND jsonb_typeof(provenance) = 'object'));

CREATE FUNCTION media_region_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'MEDIA_REGION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_region_update BEFORE UPDATE ON media_regions
  FOR EACH ROW EXECUTE FUNCTION media_region_immutable();

CREATE FUNCTION media_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.deleted_at IS NULL THEN
      RAISE EXCEPTION 'MEDIA_ARTIFACT_DELETION_UNCONFIRMED' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['expires_at','mapping_status','mapping_evidence_sha256','visual_quality','deleted_at','deletion_evidence','updated_at'])
      IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['expires_at','mapping_status','mapping_evidence_sha256','visual_quality','deleted_at','deletion_evidence','updated_at']) THEN
    RAISE EXCEPTION 'MEDIA_ARTIFACT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'MEDIA_ARTIFACT_ALREADY_DELETED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_artifact_change BEFORE UPDATE OR DELETE ON derived_media_artifacts
  FOR EACH ROW EXECUTE FUNCTION media_artifact_guard();

COMMIT;
