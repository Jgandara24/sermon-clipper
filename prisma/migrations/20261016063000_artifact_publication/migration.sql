BEGIN;

ALTER TABLE derived_media_artifacts
  ADD COLUMN publication_state TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN publication_session_id UUID,
  ADD COLUMN publication_evidence JSONB;

CREATE UNIQUE INDEX source_media_sessions_id_source_id_key ON source_media_sessions(id, source_id);
ALTER TABLE derived_media_artifacts ADD CONSTRAINT media_artifact_publication_session_fkey
  FOREIGN KEY (publication_session_id, source_video_id) REFERENCES source_media_sessions(id, source_id)
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Historical registrations have no publication proof. Never infer READY from their existence.
ALTER TABLE derived_media_artifacts ADD CONSTRAINT media_artifact_publication_check CHECK (
  (publication_state = 'PENDING' AND publication_evidence IS NULL) OR
  (publication_state = 'READY' AND publication_session_id IS NOT NULL AND
   publication_evidence IS NOT NULL AND jsonb_typeof(publication_evidence) = 'object' AND
   publication_evidence->>'sha256' IS NOT DISTINCT FROM sha256 AND
   publication_evidence->>'byteCount' IS NOT DISTINCT FROM byte_count::text AND
   jsonb_typeof(publication_evidence->'objectIdentity') IS NOT DISTINCT FROM 'object')
);

CREATE OR REPLACE FUNCTION media_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.deleted_at IS NULL THEN
      RAISE EXCEPTION 'MEDIA_ARTIFACT_DELETION_UNCONFIRMED' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['expires_at','mapping_status','mapping_evidence_sha256','visual_quality','deleted_at','deletion_evidence','updated_at','publication_state','publication_evidence'])
      IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['expires_at','mapping_status','mapping_evidence_sha256','visual_quality','deleted_at','deletion_evidence','updated_at','publication_state','publication_evidence']) THEN
    RAISE EXCEPTION 'MEDIA_ARTIFACT_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'MEDIA_ARTIFACT_ALREADY_DELETED' USING ERRCODE = '23514';
  END IF;
  IF OLD.publication_state = 'READY' AND
     (NEW.publication_state IS DISTINCT FROM OLD.publication_state OR
      NEW.publication_evidence IS DISTINCT FROM OLD.publication_evidence) THEN
    RAISE EXCEPTION 'MEDIA_ARTIFACT_PUBLICATION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
