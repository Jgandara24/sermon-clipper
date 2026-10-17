CREATE TABLE visual_boundary_escalations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 source_video_id UUID NOT NULL UNIQUE REFERENCES source_videos(id) ON DELETE CASCADE,
 boundary_decision_artifact_id UUID NOT NULL REFERENCES derived_media_artifacts(id) ON DELETE RESTRICT,
 request_identity TEXT NOT NULL CHECK (request_identity ~ '^[a-f0-9]{64}$'),
 request_evidence JSONB NOT NULL CHECK (jsonb_typeof(request_evidence) = 'object'),
 reserved_cost_micro_usd BIGINT NOT NULL CHECK (reserved_cost_micro_usd >= 0),
 budget_micro_usd BIGINT NOT NULL CHECK (budget_micro_usd > 0 AND reserved_cost_micro_usd <= budget_micro_usd),
 state TEXT NOT NULL DEFAULT 'STARTED' CHECK (state IN ('STARTED','COMPLETED','UNCERTAIN')),
 result JSONB, result_sha256 TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
 CHECK ((state='STARTED' AND finished_at IS NULL AND result IS NULL AND result_sha256 IS NULL) OR
        (state='UNCERTAIN' AND finished_at IS NOT NULL AND result IS NULL AND result_sha256 IS NULL) OR
        (state='COMPLETED' AND finished_at IS NOT NULL AND result IS NOT NULL AND result_sha256 IS NOT NULL
         AND jsonb_typeof(result)='object' AND result_sha256 ~ '^[a-f0-9]{64}$'))
);
CREATE FUNCTION guard_visual_boundary_escalation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS (SELECT 1 FROM source_videos WHERE id=OLD.source_video_id) THEN
   RAISE EXCEPTION 'VISUAL_ESCALATION_IMMUTABLE'; END IF;
  RETURN OLD;
 ELSIF TG_OP='INSERT' THEN
  IF NEW.state <> 'STARTED' OR NOT EXISTS (
    SELECT 1 FROM derived_media_artifacts a WHERE a.id=NEW.boundary_decision_artifact_id
    AND a.source_video_id=NEW.source_video_id AND a.kind='LOCAL_EVIDENCE'
    AND a.derivation_version='registered-boundary-resolution-v1' AND a.publication_state='READY' AND a.deleted_at IS NULL
    AND a.publication_evidence->'derivation'->>'boundaryStatus'='AMBIGUOUS'
  ) THEN RAISE EXCEPTION 'VISUAL_ESCALATION_AMBIGUITY_REQUIRED'; END IF;
 ELSE
  IF OLD.state <> 'STARTED' OR NEW.state NOT IN ('COMPLETED','UNCERTAIN') OR
    ROW(NEW.id,NEW.source_video_id,NEW.boundary_decision_artifact_id,NEW.request_identity,NEW.request_evidence,
        NEW.reserved_cost_micro_usd,NEW.budget_micro_usd,NEW.created_at)
      IS DISTINCT FROM
    ROW(OLD.id,OLD.source_video_id,OLD.boundary_decision_artifact_id,OLD.request_identity,OLD.request_evidence,
        OLD.reserved_cost_micro_usd,OLD.budget_micro_usd,OLD.created_at)
  THEN RAISE EXCEPTION 'VISUAL_ESCALATION_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_visual_boundary_escalation BEFORE INSERT OR UPDATE OR DELETE ON visual_boundary_escalations
 FOR EACH ROW EXECUTE FUNCTION guard_visual_boundary_escalation();
