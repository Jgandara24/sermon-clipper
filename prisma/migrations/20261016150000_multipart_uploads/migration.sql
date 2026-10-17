CREATE TABLE multipart_uploads (
 id UUID PRIMARY KEY,
 workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 storage_identity TEXT NOT NULL CHECK (length(storage_identity)>0),
 storage_key TEXT NOT NULL UNIQUE,
 filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
 total_bytes BIGINT NOT NULL CHECK (total_bytes BETWEEN 1 AND 5497558138880),
 part_bytes BIGINT NOT NULL CHECK (part_bytes BETWEEN 5242880 AND 5363466240),
 state TEXT NOT NULL DEFAULT 'NEW' CHECK (state IN ('NEW','STARTING','UPLOADING','COMPLETING','COMPLETED','ABORTING','ABORTED','UNCERTAIN')),
 provider_upload_id TEXT,
 source_video_id UUID,
 completed_etag TEXT,
 uncertain_stage TEXT CHECK (uncertain_stage IN ('STARTING','COMPLETING','ABORTING')),
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((total_bytes + part_bytes - 1) / part_bytes <= 10000),
 CHECK (storage_key = 'src/' || workspace_id::text || '/multipart-' || id::text),
 CHECK (expires_at > created_at),
 CHECK (provider_upload_id IS NULL OR length(provider_upload_id) BETWEEN 1 AND 2048),
 CHECK (state NOT IN ('UPLOADING','COMPLETING','COMPLETED','ABORTING') OR provider_upload_id IS NOT NULL),
 CHECK ((state='COMPLETED' AND source_video_id IS NOT NULL AND completed_etag IS NOT NULL) OR
        (state<>'COMPLETED' AND source_video_id IS NULL AND completed_etag IS NULL)),
 CHECK ((state='UNCERTAIN') = (uncertain_stage IS NOT NULL))
);
CREATE INDEX multipart_uploads_workspace_id_created_at_idx ON multipart_uploads(workspace_id,created_at);
CREATE INDEX multipart_uploads_state_expires_at_idx ON multipart_uploads(state,expires_at);
CREATE FUNCTION guard_multipart_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'MULTIPART_UPLOAD_AUDIT_REQUIRED';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.state <> 'NEW' OR NEW.provider_upload_id IS NOT NULL THEN
   RAISE EXCEPTION 'MULTIPART_UPLOAD_INVALID_INITIAL_STATE'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.workspace_id,NEW.storage_identity,NEW.storage_key,NEW.filename,NEW.total_bytes,NEW.part_bytes,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.storage_identity,OLD.storage_key,OLD.filename,OLD.total_bytes,OLD.part_bytes,OLD.expires_at,OLD.created_at)
  THEN RAISE EXCEPTION 'MULTIPART_UPLOAD_IDENTITY_IMMUTABLE'; END IF;
  IF NOT ((OLD.state='NEW' AND NEW.state IN ('STARTING','ABORTED')) OR
          (OLD.state='STARTING' AND NEW.state IN ('UPLOADING','UNCERTAIN')) OR
          (OLD.state='UPLOADING' AND NEW.state IN ('COMPLETING','ABORTING')) OR
          (OLD.state='COMPLETING' AND NEW.state IN ('COMPLETED','UNCERTAIN')) OR
          (OLD.state='ABORTING' AND NEW.state IN ('ABORTED','UNCERTAIN')))
  THEN RAISE EXCEPTION 'MULTIPART_UPLOAD_INVALID_TRANSITION'; END IF;
  IF NEW.provider_upload_id IS DISTINCT FROM OLD.provider_upload_id AND
     NOT (OLD.state='STARTING' AND NEW.state='UPLOADING' AND OLD.provider_upload_id IS NULL)
  THEN RAISE EXCEPTION 'MULTIPART_UPLOAD_PROVIDER_ID_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_multipart_upload BEFORE INSERT OR UPDATE OR DELETE ON multipart_uploads
 FOR EACH ROW EXECUTE FUNCTION guard_multipart_upload();
