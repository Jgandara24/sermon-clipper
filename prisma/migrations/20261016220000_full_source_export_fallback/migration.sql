-- An explicit full-source export fallback. Each row names one original-input export job,
-- the operator request, the missing-range reason, and its open review exception.
CREATE TABLE export_full_source_fallbacks (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 export_job_id UUID NOT NULL UNIQUE REFERENCES export_jobs(id) ON DELETE CASCADE,
 workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 source_video_id UUID NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
 editorial_exception_id UUID NOT NULL UNIQUE REFERENCES editorial_exceptions(id) ON DELETE RESTRICT,
 requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
 reason_code TEXT NOT NULL CHECK (reason_code IN ('EXPORT_RANGE_UNAVAILABLE')),
 reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
 edit_version INTEGER NOT NULL CHECK (edit_version >= 0),
 start_ms BIGINT NOT NULL CHECK (start_ms >= 0),
 end_ms BIGINT NOT NULL CHECK (end_ms > start_ms),
 source_byte_count BIGINT CHECK (source_byte_count IS NULL OR source_byte_count >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX export_full_source_fallbacks_workspace_created_idx ON export_full_source_fallbacks (workspace_id, created_at);
CREATE INDEX export_full_source_fallbacks_source_idx ON export_full_source_fallbacks (source_video_id);
CREATE INDEX export_full_source_fallbacks_requester_idx ON export_full_source_fallbacks (requested_by_user_id);

CREATE FUNCTION guard_export_full_source_fallback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NOT EXISTS (
    SELECT 1 FROM export_jobs j JOIN generated_clips c ON c.id = j.clip_id JOIN projects p ON p.id = c.project_id
    WHERE j.id = NEW.export_job_id AND j.workspace_id = NEW.workspace_id AND c.workspace_id = NEW.workspace_id
      AND p.workspace_id = NEW.workspace_id AND p.source_video_id = NEW.source_video_id
      AND j.edit_version = NEW.edit_version AND j.state = 'queued' AND j.attempt = 0
  ) OR EXISTS (SELECT 1 FROM export_range_inputs r WHERE r.export_job_id = NEW.export_job_id)
    OR NOT EXISTS (
    SELECT 1 FROM editorial_exceptions e WHERE e.id = NEW.editorial_exception_id
      AND e.workspace_id = NEW.workspace_id AND e.state = 'open' AND e.exception_type = 'full_source_export_fallback'
  ) THEN RAISE EXCEPTION 'FULL_SOURCE_FALLBACK_EVIDENCE_INVALID'; END IF;
  RETURN NEW;
 END IF;
 -- Only the referential SET NULL of a deleted requester may change a row.
 IF ROW(NEW.id, NEW.export_job_id, NEW.workspace_id, NEW.source_video_id, NEW.editorial_exception_id, NEW.reason_code,
        NEW.reason, NEW.edit_version, NEW.start_ms, NEW.end_ms, NEW.source_byte_count, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.export_job_id, OLD.workspace_id, OLD.source_video_id, OLD.editorial_exception_id, OLD.reason_code,
        OLD.reason, OLD.edit_version, OLD.start_ms, OLD.end_ms, OLD.source_byte_count, OLD.created_at)
    OR (NEW.requested_by_user_id IS NOT NULL AND NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id)
 THEN RAISE EXCEPTION 'FULL_SOURCE_FALLBACK_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_export_full_source_fallback BEFORE INSERT OR UPDATE ON export_full_source_fallbacks
 FOR EACH ROW EXECUTE FUNCTION guard_export_full_source_fallback();

-- A fallback job cannot later gain a range pin.
CREATE FUNCTION guard_range_input_not_fallback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM export_full_source_fallbacks f WHERE f.export_job_id = NEW.export_job_id) THEN
  RAISE EXCEPTION 'FULL_SOURCE_FALLBACK_RANGE_CONFLICT'; END IF;
 RETURN NEW;
END $$;
-- The name sorts before export_range_input_guard, so this specific refusal fires first.
CREATE TRIGGER export_range_input_fallback_guard BEFORE INSERT ON export_range_inputs
 FOR EACH ROW EXECUTE FUNCTION guard_range_input_not_fallback();
