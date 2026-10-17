BEGIN;
CREATE TABLE media_artifact_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL REFERENCES derived_media_artifacts(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  reviewer_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('ACCEPTED','REJECTED')),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  mapping_evidence_sha256 text NOT NULL CHECK (mapping_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object')
    CHECK (COALESCE(jsonb_typeof(evidence->'notes')='string' AND length(btrim(evidence->>'notes'))>0,false))
    CHECK (COALESCE(jsonb_typeof(evidence->'comparisonReference')='string' AND length(btrim(evidence->>'comparisonReference'))>0,false))
    CHECK (decision <> 'ACCEPTED' OR evidence @> '{"fullRangeCompared":true,"dimensionsChecked":true,"timingChecked":true,"visualQualityAcceptable":true}'::jsonb),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, revision)
);

CREATE FUNCTION media_artifact_review_append() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a derived_media_artifacts; last_revision integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'MEDIA_ARTIFACT_REVIEW_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO a FROM derived_media_artifacts WHERE id=NEW.artifact_id FOR UPDATE;
  IF a.id IS NULL OR a.kind <> 'CANDIDATE_RANGE' OR a.publication_state <> 'READY' OR
    a.mapping_status <> 'VERIFIED' OR a.deleted_at IS NOT NULL OR
    a.source_sha256 IS DISTINCT FROM NEW.source_sha256 OR a.sha256 IS DISTINCT FROM NEW.artifact_sha256 OR
    a.mapping_evidence_sha256 IS DISTINCT FROM NEW.mapping_evidence_sha256 THEN
    RAISE EXCEPTION 'MEDIA_ARTIFACT_REVIEW_BYTES_CHANGED' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM source_media_sessions WHERE source_id=a.source_video_id AND state <> 'COMPLETE') THEN
    RAISE EXCEPTION 'MEDIA_ARTIFACT_REVIEW_SESSION_UNFINISHED' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(MAX(revision),0) INTO last_revision FROM media_artifact_reviews WHERE artifact_id=NEW.artifact_id;
  IF NEW.revision <> last_revision+1 THEN
    RAISE EXCEPTION 'MEDIA_ARTIFACT_REVIEW_REVISION_CHANGED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER media_artifact_review_append BEFORE INSERT OR UPDATE OR DELETE ON media_artifact_reviews
FOR EACH ROW EXECUTE FUNCTION media_artifact_review_append();

CREATE FUNCTION media_artifact_review_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a derived_media_artifacts; r media_artifact_reviews; artifact_uuid uuid;
BEGIN
  IF TG_TABLE_NAME='media_artifact_reviews' THEN artifact_uuid := NEW.artifact_id;
  ELSE artifact_uuid := NEW.id; END IF;
  SELECT * INTO a FROM derived_media_artifacts WHERE id=artifact_uuid;
  IF a.id IS NULL OR a.kind <> 'CANDIDATE_RANGE' OR a.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT * INTO r FROM media_artifact_reviews WHERE artifact_id=artifact_uuid ORDER BY revision DESC LIMIT 1;
  IF a.visual_quality IN ('ACCEPTED','REJECTED') OR r.id IS NOT NULL THEN
    IF r.id IS NULL OR a.visual_quality IS DISTINCT FROM r.decision OR
      a.sha256 IS DISTINCT FROM r.artifact_sha256 OR a.source_sha256 IS DISTINCT FROM r.source_sha256 OR
      a.mapping_evidence_sha256 IS DISTINCT FROM r.mapping_evidence_sha256 THEN
      RAISE EXCEPTION 'MEDIA_ARTIFACT_REVIEW_REQUIRED' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER media_artifact_review_consistent AFTER INSERT OR UPDATE ON derived_media_artifacts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION media_artifact_review_consistent();
CREATE CONSTRAINT TRIGGER media_artifact_review_decision_consistent AFTER INSERT ON media_artifact_reviews
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION media_artifact_review_consistent();
COMMIT;
