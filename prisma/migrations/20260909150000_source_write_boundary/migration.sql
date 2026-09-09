-- Baseline 0 is a rollout token, not a claim that historical word mappings were verified.
ALTER TABLE source_videos ADD COLUMN transcript_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generated_clips ADD COLUMN transcript_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_videos ADD CONSTRAINT source_transcript_revision_nonnegative CHECK (transcript_revision >= 0);
ALTER TABLE generated_clips ADD CONSTRAINT clip_transcript_revision_nonnegative CHECK (transcript_revision >= 0);

-- BEFORE INSERT runs before the foreign-key check takes any clip-row lock. Both TRANSCRIBE
-- and ANALYZE take this same source lock before their final durable-work count. A writer
-- that waits must read the revision again: ordering alone cannot validate an old request.
CREATE FUNCTION lock_current_clip_transcript(requested_clip UUID) RETURNS VOID AS $$
DECLARE
  locked_source UUID;
  current_source UUID;
  clip_revision INTEGER;
  source_revision INTEGER;
BEGIN
  SELECT p.source_video_id INTO locked_source
    FROM generated_clips c JOIN projects p ON p.id = c.project_id WHERE c.id = requested_clip;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLIP_TRANSCRIPT_CHANGED' USING ERRCODE = '23514', CONSTRAINT = 'clip_transcript_revision_current';
  END IF;
  -- Some historical/test clips have no source. No transcript can be replaced for those rows.
  IF locked_source IS NULL THEN RETURN; END IF;
  PERFORM id FROM source_videos WHERE id = locked_source FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLIP_TRANSCRIPT_CHANGED' USING ERRCODE = '23514', CONSTRAINT = 'clip_transcript_revision_current';
  END IF;
  -- Separate statement: READ COMMITTED gets the committed rows after a lock wait. At stricter
  -- isolation a concurrent source revision change aborts with a serialization failure instead.
  SELECT p.source_video_id, c.transcript_revision, s.transcript_revision
    INTO current_source, clip_revision, source_revision
    FROM generated_clips c JOIN projects p ON p.id = c.project_id
    JOIN source_videos s ON s.id = p.source_video_id WHERE c.id = requested_clip;
  IF NOT FOUND OR current_source IS DISTINCT FROM locked_source OR clip_revision <> source_revision THEN
    RAISE EXCEPTION 'CLIP_TRANSCRIPT_CHANGED' USING ERRCODE = '23514', CONSTRAINT = 'clip_transcript_revision_current';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_clip_transcript_write() RETURNS TRIGGER AS $$
BEGIN
  PERFORM lock_current_clip_transcript(NEW.clip_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clip_edit_source_boundary BEFORE INSERT OR UPDATE OF clip_id, editor_state ON clip_edits
  FOR EACH ROW EXECUTE FUNCTION guard_clip_transcript_write();
CREATE TRIGGER clip_approval_source_boundary BEFORE INSERT OR UPDATE OF clip_id ON clip_approvals
  FOR EACH ROW EXECUTE FUNCTION guard_clip_transcript_write();
CREATE TRIGGER export_job_source_boundary BEFORE INSERT OR UPDATE OF clip_id ON export_jobs
  FOR EACH ROW EXECUTE FUNCTION guard_clip_transcript_write();

-- An old ANALYZE worker must not silently create revision-0 clips after a replacement.
-- Existing clips cannot be relabelled to make stale editor documents appear current.
CREATE FUNCTION guard_generated_clip_revision() RETURNS TRIGGER AS $$
DECLARE
  locked_source UUID;
  current_source UUID;
  source_revision INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.transcript_revision <> OLD.transcript_revision THEN
    RAISE EXCEPTION 'CLIP_TRANSCRIPT_CHANGED' USING ERRCODE = '23514', CONSTRAINT = 'clip_transcript_revision_current';
  END IF;
  SELECT source_video_id INTO locked_source FROM projects WHERE id = NEW.project_id;
  IF locked_source IS NULL THEN RETURN NEW; END IF;
  PERFORM id FROM source_videos WHERE id = locked_source FOR UPDATE;
  SELECT p.source_video_id, s.transcript_revision INTO current_source, source_revision
    FROM projects p JOIN source_videos s ON s.id = p.source_video_id WHERE p.id = NEW.project_id;
  IF NOT FOUND OR current_source IS DISTINCT FROM locked_source OR NEW.transcript_revision <> source_revision THEN
    RAISE EXCEPTION 'CLIP_TRANSCRIPT_CHANGED' USING ERRCODE = '23514', CONSTRAINT = 'clip_transcript_revision_current';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generated_clip_source_boundary BEFORE INSERT OR UPDATE OF project_id, transcript_revision ON generated_clips
  FOR EACH ROW EXECUTE FUNCTION guard_generated_clip_revision();

-- Posts without a live clip and detached review snapshots still count as durable work.
-- Lock their source through the project, even when there are no live word references.
CREATE FUNCTION lock_project_transcript(requested_project UUID) RETURNS VOID AS $$
DECLARE locked_source UUID;
BEGIN
  SELECT source_video_id INTO locked_source FROM projects WHERE id = requested_project;
  IF locked_source IS NOT NULL THEN
    PERFORM id FROM source_videos WHERE id = locked_source FOR UPDATE;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION guard_post_transcript_write() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.publish_status IN ('in_progress', 'succeeded', 'blocked') THEN
    IF NEW.clip_id IS NOT NULL THEN
      PERFORM lock_current_clip_transcript(NEW.clip_id);
    ELSE
      PERFORM lock_project_transcript(NEW.project_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER scheduled_post_source_boundary BEFORE INSERT OR UPDATE OF publish_status, clip_id, project_id ON scheduled_posts
  FOR EACH ROW EXECUTE FUNCTION guard_post_transcript_write();

CREATE FUNCTION guard_review_transcript_write() RETURNS TRIGGER AS $$
BEGIN
  PERFORM lock_project_transcript(NEW.project_id_snapshot);
  IF EXISTS (SELECT 1 FROM generated_clips WHERE id = NEW.clip_id_snapshot) THEN
    PERFORM lock_current_clip_transcript(NEW.clip_id_snapshot);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER clip_review_source_boundary BEFORE INSERT ON clip_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_review_transcript_write();
