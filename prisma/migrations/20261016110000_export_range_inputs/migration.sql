BEGIN;
CREATE TABLE export_range_inputs (
  export_job_id uuid PRIMARY KEY REFERENCES export_jobs(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES derived_media_artifacts(id) ON DELETE RESTRICT,
  review_id uuid NOT NULL REFERENCES media_artifact_reviews(id) ON DELETE RESTRICT,
  source_video_id uuid NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  mapping_evidence_sha256 text NOT NULL CHECK (mapping_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  edit_version integer NOT NULL CHECK (edit_version >= 0),
  start_ms bigint NOT NULL CHECK (start_ms >= 0),
  end_ms bigint NOT NULL CHECK (end_ms > start_ms AND end_ms <= 9007199254740991),
  created_at timestamptz(6) NOT NULL DEFAULT now()
);
CREATE FUNCTION export_range_input_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a derived_media_artifacts; r media_artifact_reviews; j export_jobs; source_id uuid;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'EXPORT_RANGE_INPUT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN
    IF EXISTS (SELECT 1 FROM export_jobs WHERE id=OLD.export_job_id) THEN
      RAISE EXCEPTION 'EXPORT_RANGE_INPUT_IMMUTABLE' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO j FROM export_jobs WHERE id=NEW.export_job_id FOR UPDATE;
  SELECT p.source_video_id INTO source_id FROM generated_clips c JOIN projects p ON p.id=c.project_id WHERE c.id=j.clip_id;
  SELECT * INTO a FROM derived_media_artifacts WHERE id=NEW.artifact_id;
  SELECT * INTO r FROM media_artifact_reviews WHERE id=NEW.review_id;
  IF j.id IS NULL OR j.state::text <> 'queued' OR j.attempt <> 0 OR j.edit_version IS DISTINCT FROM NEW.edit_version OR
    a.id IS NULL OR r.id IS NULL OR source_id IS DISTINCT FROM NEW.source_video_id OR a.source_video_id IS DISTINCT FROM source_id OR
    a.kind <> 'CANDIDATE_RANGE' OR a.publication_state <> 'READY' OR a.mapping_status <> 'VERIFIED' OR
    a.visual_quality <> 'ACCEPTED' OR a.deleted_at IS NOT NULL OR (a.expires_at IS NOT NULL AND a.expires_at <= clock_timestamp()) OR
    a.source_sha256 IS DISTINCT FROM NEW.source_sha256 OR a.sha256 IS DISTINCT FROM NEW.artifact_sha256 OR
    a.mapping_evidence_sha256 IS DISTINCT FROM NEW.mapping_evidence_sha256 OR a.start_ms > NEW.start_ms OR a.end_ms < NEW.end_ms OR
    r.artifact_id IS DISTINCT FROM a.id OR r.decision <> 'ACCEPTED' OR r.artifact_sha256 IS DISTINCT FROM a.sha256 OR
    r.source_sha256 IS DISTINCT FROM a.source_sha256 OR r.mapping_evidence_sha256 IS DISTINCT FROM a.mapping_evidence_sha256 OR
    EXISTS (SELECT 1 FROM media_artifact_reviews WHERE artifact_id=a.id AND revision > r.revision) THEN
    RAISE EXCEPTION 'EXPORT_RANGE_INPUT_NOT_PINNABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER export_range_input_guard BEFORE INSERT OR UPDATE OR DELETE ON export_range_inputs
FOR EACH ROW EXECUTE FUNCTION export_range_input_guard();
COMMIT;
