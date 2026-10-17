ALTER TABLE multipart_uploads ADD COLUMN cancellation_recovery_evidence JSONB;
ALTER TABLE multipart_uploads ADD CONSTRAINT multipart_cancellation_evidence_check CHECK (
 cancellation_recovery_evidence IS NULL OR (
  state='ABORTED' AND jsonb_typeof(cancellation_recovery_evidence)='object' AND provider_upload_id IS NOT NULL AND
  cancellation_recovery_evidence->>'version' IS NOT NULL AND cancellation_recovery_evidence->>'version'='multipart-cancellation-recovery-v1' AND
  cancellation_recovery_evidence->>'uploadId' IS NOT NULL AND cancellation_recovery_evidence->>'uploadId'=provider_upload_id AND
  cancellation_recovery_evidence->>'sessionId' IS NOT NULL AND cancellation_recovery_evidence->>'sessionId'=id::text AND
  cancellation_recovery_evidence->>'storageKey' IS NOT NULL AND cancellation_recovery_evidence->>'storageKey'=storage_key AND
  cancellation_recovery_evidence->>'storageIdentity' IS NOT NULL AND cancellation_recovery_evidence->>'storageIdentity'=storage_identity AND
  cancellation_recovery_evidence->>'uploadAbsent' IS NOT NULL AND cancellation_recovery_evidence->>'uploadAbsent'='true' AND
  cancellation_recovery_evidence->>'completedObjectAbsent' IS NOT NULL AND cancellation_recovery_evidence->>'completedObjectAbsent'='true'
 ));
CREATE OR REPLACE FUNCTION guard_multipart_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'MULTIPART_UPLOAD_AUDIT_REQUIRED';
 ELSIF TG_OP='INSERT' THEN
  IF NEW.state <> 'NEW' OR NEW.provider_upload_id IS NOT NULL OR NEW.recovery_evidence IS NOT NULL OR NEW.initiation_recovery_evidence IS NOT NULL OR NEW.cancellation_recovery_evidence IS NOT NULL THEN
   RAISE EXCEPTION 'MULTIPART_UPLOAD_INVALID_INITIAL_STATE'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.workspace_id,NEW.storage_identity,NEW.storage_key,NEW.filename,NEW.total_bytes,NEW.part_bytes,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.storage_identity,OLD.storage_key,OLD.filename,OLD.total_bytes,OLD.part_bytes,OLD.expires_at,OLD.created_at)
  THEN RAISE EXCEPTION 'MULTIPART_UPLOAD_IDENTITY_IMMUTABLE'; END IF;
  IF NOT ((OLD.state='NEW' AND NEW.state IN ('STARTING','ABORTED')) OR
          (OLD.state='STARTING' AND NEW.state IN ('UPLOADING','UNCERTAIN')) OR
          (OLD.state='UPLOADING' AND NEW.state IN ('COMPLETING','ABORTING')) OR
          (OLD.state='COMPLETING' AND NEW.state IN ('COMPLETED','UNCERTAIN')) OR
          (OLD.state='ABORTING' AND NEW.state IN ('ABORTED','UNCERTAIN')) OR
          (OLD.state='UNCERTAIN' AND OLD.uncertain_stage='COMPLETING' AND NEW.state='COMPLETED' AND NEW.recovery_evidence IS NOT NULL) OR
          (OLD.state='UNCERTAIN' AND OLD.uncertain_stage='STARTING' AND NEW.state='UPLOADING' AND NEW.initiation_recovery_evidence IS NOT NULL) OR
          (OLD.state='UNCERTAIN' AND OLD.uncertain_stage='ABORTING' AND NEW.state='ABORTED' AND NEW.cancellation_recovery_evidence IS NOT NULL))
  THEN RAISE EXCEPTION 'MULTIPART_UPLOAD_INVALID_TRANSITION'; END IF;
  IF NEW.provider_upload_id IS DISTINCT FROM OLD.provider_upload_id AND
     NOT (NEW.state='UPLOADING' AND OLD.provider_upload_id IS NULL AND
       (OLD.state='STARTING' OR (OLD.state='UNCERTAIN' AND OLD.uncertain_stage='STARTING' AND NEW.initiation_recovery_evidence IS NOT NULL)))
  THEN RAISE EXCEPTION 'MULTIPART_UPLOAD_PROVIDER_ID_IMMUTABLE'; END IF;
  IF NEW.recovery_evidence IS DISTINCT FROM OLD.recovery_evidence AND NOT
     (OLD.state='UNCERTAIN' AND OLD.uncertain_stage='COMPLETING' AND NEW.state='COMPLETED' AND OLD.recovery_evidence IS NULL)
  THEN RAISE EXCEPTION 'MULTIPART_RECOVERY_EVIDENCE_IMMUTABLE'; END IF;
  IF NEW.initiation_recovery_evidence IS DISTINCT FROM OLD.initiation_recovery_evidence AND NOT
     (OLD.state='UNCERTAIN' AND OLD.uncertain_stage='STARTING' AND NEW.state='UPLOADING' AND OLD.initiation_recovery_evidence IS NULL)
  THEN RAISE EXCEPTION 'MULTIPART_INITIATION_EVIDENCE_IMMUTABLE'; END IF;
  IF NEW.cancellation_recovery_evidence IS DISTINCT FROM OLD.cancellation_recovery_evidence AND NOT
     (OLD.state='UNCERTAIN' AND OLD.uncertain_stage='ABORTING' AND NEW.state='ABORTED' AND OLD.cancellation_recovery_evidence IS NULL)
  THEN RAISE EXCEPTION 'MULTIPART_CANCELLATION_EVIDENCE_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
