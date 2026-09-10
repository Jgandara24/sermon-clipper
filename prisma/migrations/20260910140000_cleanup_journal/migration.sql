BEGIN;
-- Additive journal only. No cleanup runner or existing writer is enabled here.
CREATE TABLE cleanup_operations (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 operator_id uuid NOT NULL, canonical_manifest text NOT NULL, manifest jsonb NOT NULL,
 manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
 backup_manifest_hash text NOT NULL CHECK (backup_manifest_hash ~ '^[a-f0-9]{64}$'),
 preserved_records_hash text NOT NULL CHECK (preserved_records_hash ~ '^[a-f0-9]{64}$'),
 storage_identity text NOT NULL CHECK (storage_identity ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'PREPARED' CHECK (state IN ('PREPARED','QUIESCING','READY','APPLYING','NEEDS_RECONCILIATION','COMPLETE','ABORTED')),
 revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
 owner_id uuid, ownership_generation bigint NOT NULL DEFAULT 0 CHECK (ownership_generation >= 0),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(id, manifest_hash),
 CHECK (manifest = canonical_manifest::jsonb),
 CHECK (manifest->'version' IS NOT DISTINCT FROM '1'::jsonb),
 CHECK (manifest_hash = encode(digest(canonical_manifest, 'sha256'), 'hex')),
 CHECK (manifest->>'operationId' IS NOT DISTINCT FROM id::text),
 CHECK (manifest->>'operatorId' IS NOT DISTINCT FROM operator_id::text),
 CHECK (manifest->>'workspaceId' IS NOT DISTINCT FROM workspace_id::text),
 CHECK (manifest->>'backupManifestHash' IS NOT DISTINCT FROM backup_manifest_hash),
 CHECK (manifest->>'preservedRecordsHash' IS NOT DISTINCT FROM preserved_records_hash),
 CHECK (jsonb_typeof(manifest->'identity') IS NOT DISTINCT FROM 'object'),
 CHECK (storage_identity = encode(digest((manifest->'identity')::text, 'sha256'), 'hex'))
);
CREATE TABLE cleanup_objects (
 id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES cleanup_operations(id) ON DELETE RESTRICT,
 ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 5),
 source_id uuid NOT NULL REFERENCES source_videos(id) ON DELETE RESTRICT,
 project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 field_name text NOT NULL CHECK (field_name IN ('storage_key','audio_key','thumbnail_key')),
 storage_key text NOT NULL CHECK (octet_length(storage_key) BETWEEN 1 AND 1024),
 bytes bigint NOT NULL CHECK (bytes > 0), sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 etag text NOT NULL CHECK (length(etag)>0), head_modified_at text NOT NULL, list_modified_at text NOT NULL,
 metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata)='object'),
 state text NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','INTENT_RECORDED','ABSENCE_CONFIRMED','RECORD_COMMITTED')),
 revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
 absence_evidence jsonb,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(operation_id,ordinal), UNIQUE(operation_id,storage_key), UNIQUE(operation_id,source_id,field_name),
 CHECK (state NOT IN ('ABSENCE_CONFIRMED','RECORD_COMMITTED') OR
   (absence_evidence IS NOT NULL AND jsonb_typeof(absence_evidence)='object' AND absence_evidence <> '{}'::jsonb))
);
CREATE TABLE cleanup_approvals (
 id uuid PRIMARY KEY, operation_id uuid NOT NULL, manifest_hash text NOT NULL,
 approver_id uuid NOT NULL, scope text NOT NULL CHECK (scope IN ('EXECUTE','RECONCILE','RESTORE')),
 issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 FOREIGN KEY(operation_id,manifest_hash) REFERENCES cleanup_operations(id,manifest_hash) ON DELETE RESTRICT,
 CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '30 minutes'),
 CHECK (revoked_at IS NULL OR revoked_at>=issued_at)
);
CREATE TABLE source_media_gates (
 source_id uuid PRIMARY KEY REFERENCES source_videos(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','QUIESCING','RETIRED','RESTORING')),
 generation bigint NOT NULL DEFAULT 0 CHECK (generation>=0),
 operation_id uuid REFERENCES cleanup_operations(id) ON DELETE RESTRICT,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((state='ACTIVE' AND operation_id IS NULL) OR (state<>'ACTIVE' AND operation_id IS NOT NULL))
);
CREATE TABLE source_media_sessions (
 id uuid PRIMARY KEY, source_id uuid NOT NULL REFERENCES source_media_gates(source_id) ON DELETE RESTRICT,
 generation bigint NOT NULL CHECK (generation>=0), owner_id uuid NOT NULL,
 purpose text NOT NULL CHECK (length(purpose)>0),
 state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','UNCERTAIN','COMPLETE')),
 revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0), terminal_evidence jsonb,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (state<>'COMPLETE' OR (terminal_evidence IS NOT NULL AND jsonb_typeof(terminal_evidence)='object' AND terminal_evidence<>'{}'::jsonb))
);
CREATE INDEX source_media_sessions_open ON source_media_sessions(source_id) WHERE state<>'COMPLETE';
CREATE TABLE media_key_reservations (
 id uuid PRIMARY KEY, storage_identity text NOT NULL CHECK (storage_identity ~ '^[a-f0-9]{64}$'),
 storage_key text NOT NULL CHECK (octet_length(storage_key) BETWEEN 1 AND 1024),
 operation_id uuid REFERENCES cleanup_operations(id) ON DELETE RESTRICT,
 session_id uuid REFERENCES source_media_sessions(id) ON DELETE RESTRICT,
 state text NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD','RELEASED')),
 revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0), resolution jsonb,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((operation_id IS NULL) <> (session_id IS NULL)),
 CHECK (state<>'RELEASED' OR (resolution IS NOT NULL AND jsonb_typeof(resolution)='object' AND resolution<>'{}'::jsonb))
);
CREATE UNIQUE INDEX media_key_reservations_held ON media_key_reservations(storage_identity,storage_key) WHERE state='HELD';
CREATE TABLE cleanup_audit_events (
 id uuid PRIMARY KEY, operation_id uuid REFERENCES cleanup_operations(id) ON DELETE RESTRICT,
 target_type text NOT NULL CHECK (target_type IN ('operation','object','gate','session','reservation','approval')),
 target_id uuid NOT NULL, transaction_id bigint NOT NULL DEFAULT txid_current(), revision bigint NOT NULL CHECK (revision>=0),
 action text NOT NULL, actor_id uuid NOT NULL, evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(target_type,target_id,revision)
);
-- Existing sources remain ACTIVE; no session or cleanup is started. New writer admission is a later stage.
INSERT INTO source_media_gates(source_id) SELECT id FROM source_videos;

CREATE FUNCTION cleanup_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CLEANUP_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END $$;
CREATE TRIGGER cleanup_operations_no_truncate BEFORE TRUNCATE ON cleanup_operations FOR EACH STATEMENT EXECUTE FUNCTION cleanup_immutable();
CREATE TRIGGER cleanup_objects_no_truncate BEFORE TRUNCATE ON cleanup_objects FOR EACH STATEMENT EXECUTE FUNCTION cleanup_immutable();
CREATE TRIGGER cleanup_approvals_no_truncate BEFORE TRUNCATE ON cleanup_approvals FOR EACH STATEMENT EXECUTE FUNCTION cleanup_immutable();
CREATE TRIGGER source_media_gates_no_truncate BEFORE TRUNCATE ON source_media_gates FOR EACH STATEMENT EXECUTE FUNCTION cleanup_immutable();
CREATE TRIGGER source_media_sessions_no_truncate BEFORE TRUNCATE ON source_media_sessions FOR EACH STATEMENT EXECUTE FUNCTION cleanup_immutable();
CREATE TRIGGER media_key_reservations_no_truncate BEFORE TRUNCATE ON media_key_reservations FOR EACH STATEMENT EXECUTE FUNCTION cleanup_immutable();
CREATE TRIGGER cleanup_audit_events_no_truncate BEFORE TRUNCATE ON cleanup_audit_events FOR EACH STATEMENT EXECUTE FUNCTION cleanup_immutable();
-- The server supplies this value. Callers cannot reuse a prior transaction's event.
CREATE FUNCTION cleanup_audit_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.transaction_id := txid_current(); RETURN NEW; END $$;
CREATE TRIGGER cleanup_audit_transaction BEFORE INSERT ON cleanup_audit_events FOR EACH ROW EXECUTE FUNCTION cleanup_audit_stamp();
CREATE TRIGGER cleanup_audit_immutable BEFORE UPDATE OR DELETE ON cleanup_audit_events FOR EACH ROW EXECUTE FUNCTION cleanup_immutable();

-- Scope identity cannot change. Valid state changes advance one revision, with matching audit at commit.
CREATE FUNCTION cleanup_guard_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE oldj jsonb; newj jsonb; allowed boolean := false;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CLEANUP_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.revision<>0 THEN RAISE EXCEPTION 'CLEANUP_INITIAL_REVISION' USING ERRCODE='23514'; END IF;
   IF (TG_TABLE_NAME='cleanup_operations' AND NEW.state<>'PREPARED') OR
      (TG_TABLE_NAME='cleanup_objects' AND NEW.state<>'PLANNED') OR
      (TG_TABLE_NAME='source_media_sessions' AND NEW.state<>'ACTIVE') OR
      (TG_TABLE_NAME='media_key_reservations' AND NEW.state<>'HELD') THEN
     RAISE EXCEPTION 'CLEANUP_INITIAL_STATE' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 oldj := to_jsonb(OLD); newj := to_jsonb(NEW);
 IF (oldj - ARRAY['state','revision','updated_at','absence_evidence','terminal_evidence','resolution','owner_id','ownership_generation']) <>
    (newj - ARRAY['state','revision','updated_at','absence_evidence','terminal_evidence','resolution','owner_id','ownership_generation']) THEN
   RAISE EXCEPTION 'CLEANUP_SCOPE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at THEN
   RAISE EXCEPTION 'CLEANUP_REVISION_INVALID' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='cleanup_operations' THEN
   allowed := (OLD.state='PREPARED' AND NEW.state IN ('QUIESCING','ABORTED')) OR
    (OLD.state='QUIESCING' AND NEW.state IN ('READY','ABORTED','NEEDS_RECONCILIATION')) OR
    (OLD.state='READY' AND NEW.state IN ('APPLYING','ABORTED','NEEDS_RECONCILIATION')) OR
    (OLD.state='APPLYING' AND NEW.state IN ('COMPLETE','NEEDS_RECONCILIATION')) OR
    (OLD.state='NEEDS_RECONCILIATION' AND NEW.state='APPLYING');
   -- Owner replacement is a separate reviewed control, not a lease-expiry shortcut.
   IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.ownership_generation<>OLD.ownership_generation THEN
     RAISE EXCEPTION 'CLEANUP_OWNER_IMMUTABLE' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='cleanup_objects' THEN
   allowed := (OLD.state='PLANNED' AND NEW.state='INTENT_RECORDED') OR
    (OLD.state='INTENT_RECORDED' AND NEW.state='ABSENCE_CONFIRMED') OR
    (OLD.state='ABSENCE_CONFIRMED' AND NEW.state='RECORD_COMMITTED');
   IF OLD.absence_evidence IS NOT NULL AND NEW.absence_evidence IS DISTINCT FROM OLD.absence_evidence THEN
     RAISE EXCEPTION 'CLEANUP_EVIDENCE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='source_media_sessions' THEN
   allowed := (OLD.state='ACTIVE' AND NEW.state IN ('UNCERTAIN','COMPLETE')) OR (OLD.state='UNCERTAIN' AND NEW.state='COMPLETE');
   IF NEW.owner_id<>OLD.owner_id THEN RAISE EXCEPTION 'CLEANUP_OWNER_IMMUTABLE' USING ERRCODE='23514'; END IF;
 ELSE allowed := OLD.state='HELD' AND NEW.state='RELEASED';
 END IF;
 IF NOT allowed THEN RAISE EXCEPTION 'CLEANUP_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cleanup_operation_change BEFORE INSERT OR UPDATE OR DELETE ON cleanup_operations FOR EACH ROW EXECUTE FUNCTION cleanup_guard_change();
CREATE TRIGGER cleanup_object_change BEFORE INSERT OR UPDATE OR DELETE ON cleanup_objects FOR EACH ROW EXECUTE FUNCTION cleanup_guard_change();
CREATE TRIGGER cleanup_session_change BEFORE INSERT OR UPDATE OR DELETE ON source_media_sessions FOR EACH ROW EXECUTE FUNCTION cleanup_guard_change();
CREATE TRIGGER cleanup_reservation_change BEFORE INSERT OR UPDATE OR DELETE ON media_key_reservations FOR EACH ROW EXECUTE FUNCTION cleanup_guard_change();

CREATE FUNCTION cleanup_gate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   -- Only an unused backfill gate may follow its deleted parent. Direct deletion and
   -- all gate/session/audit history remain protected. Cleanup object FKs also restrict sources.
   IF OLD.state='ACTIVE' AND OLD.generation=0 AND OLD.operation_id IS NULL AND
      NOT EXISTS(SELECT 1 FROM source_videos WHERE id=OLD.source_id) AND
      NOT EXISTS(SELECT 1 FROM source_media_sessions WHERE source_id=OLD.source_id) AND
      NOT EXISTS(SELECT 1 FROM cleanup_audit_events WHERE target_type='gate' AND target_id=OLD.source_id) THEN RETURN OLD; END IF;
   RAISE EXCEPTION 'CLEANUP_HISTORY_IMMUTABLE' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'ACTIVE' OR NEW.generation<>0 THEN RAISE EXCEPTION 'CLEANUP_GATE_INITIAL' USING ERRCODE='23514'; END IF;
 ELSE
   IF NEW.source_id<>OLD.source_id OR NEW.generation<>OLD.generation+1 OR NEW.updated_at<OLD.updated_at OR
      NOT ((OLD.state='ACTIVE' AND NEW.state='QUIESCING') OR (OLD.state='QUIESCING' AND NEW.state IN ('ACTIVE','RETIRED')) OR
           (OLD.state='RETIRED' AND NEW.state='RESTORING') OR (OLD.state='RESTORING' AND NEW.state IN ('ACTIVE','RETIRED'))) THEN
     RAISE EXCEPTION 'CLEANUP_GATE_TRANSITION' USING ERRCODE='23514'; END IF;
   IF OLD.operation_id IS NOT NULL AND NEW.operation_id IS NOT NULL AND NEW.operation_id<>OLD.operation_id THEN
     RAISE EXCEPTION 'CLEANUP_GATE_OWNER' USING ERRCODE='23514'; END IF;
 END IF;
 -- Restoration needs a separate adapter and approval check. Keep it disabled.
 IF NEW.state='RESTORING' THEN RAISE EXCEPTION 'CLEANUP_RESTORE_DISABLED' USING ERRCODE='23514'; END IF;
 IF NEW.state='RETIRED' AND EXISTS(SELECT 1 FROM source_media_sessions WHERE source_id=NEW.source_id AND state<>'COMPLETE') THEN
   RAISE EXCEPTION 'CLEANUP_SESSION_OPEN' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cleanup_gate_change BEFORE INSERT OR UPDATE OR DELETE ON source_media_gates FOR EACH ROW EXECUTE FUNCTION cleanup_gate_guard();
CREATE FUNCTION cleanup_session_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gate source_media_gates;
BEGIN
 SELECT * INTO gate FROM source_media_gates WHERE source_id=NEW.source_id FOR UPDATE;
 IF NOT FOUND OR gate.state<>'ACTIVE' OR NEW.generation<>gate.generation THEN
   RAISE EXCEPTION 'CLEANUP_SOURCE_NOT_ACTIVE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cleanup_session_admission BEFORE INSERT ON source_media_sessions FOR EACH ROW EXECUTE FUNCTION cleanup_session_admit();
CREATE FUNCTION cleanup_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CLEANUP_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'revoked_at')<>(to_jsonb(OLD)-'revoked_at') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL) THEN
   RAISE EXCEPTION 'CLEANUP_APPROVAL_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cleanup_approval_change BEFORE UPDATE OR DELETE ON cleanup_approvals FOR EACH ROW EXECUTE FUNCTION cleanup_approval_guard();

-- At commit, require audit for each transition, including intermediate revisions in one transaction.
CREATE FUNCTION cleanup_require_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; target uuid; rev bigint; op uuid; expected_action text;
BEGIN
 kind := CASE TG_TABLE_NAME WHEN 'cleanup_operations' THEN 'operation' WHEN 'cleanup_objects' THEN 'object'
   WHEN 'source_media_gates' THEN 'gate' WHEN 'source_media_sessions' THEN 'session'
   WHEN 'cleanup_approvals' THEN 'approval' ELSE 'reservation' END;
 target := (to_jsonb(NEW)->>CASE WHEN kind='gate' THEN 'source_id' ELSE 'id' END)::uuid;
 rev := CASE WHEN kind='gate' THEN (to_jsonb(NEW)->>'generation')::bigint WHEN kind='approval' THEN CASE WHEN TG_OP='INSERT' THEN 0 ELSE 1 END ELSE (to_jsonb(NEW)->>'revision')::bigint END;
 IF kind='gate' AND TG_OP='INSERT' THEN RETURN NULL; END IF;
 op := CASE WHEN kind='operation' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'operation_id')::uuid END;
 expected_action := CASE WHEN kind='approval' THEN CASE WHEN TG_OP='INSERT' THEN 'GRANTED' ELSE 'REVOKED' END ELSE to_jsonb(NEW)->>'state' END;
 IF NOT EXISTS(SELECT 1 FROM cleanup_audit_events a WHERE a.target_type=kind AND a.target_id=target AND a.revision=rev
   AND a.action=expected_action AND a.operation_id IS NOT DISTINCT FROM op) THEN
   RAISE EXCEPTION 'CLEANUP_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM cleanup_audit_events a WHERE a.target_type=kind AND a.target_id=target AND a.revision=rev
   AND a.action=expected_action AND a.operation_id IS NOT DISTINCT FROM op AND a.transaction_id=txid_current()) THEN
   RAISE EXCEPTION 'CLEANUP_AUDIT_TRANSACTION_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cleanup_op_audit AFTER INSERT OR UPDATE ON cleanup_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cleanup_require_audit();
CREATE CONSTRAINT TRIGGER cleanup_obj_audit AFTER INSERT OR UPDATE ON cleanup_objects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cleanup_require_audit();
CREATE CONSTRAINT TRIGGER cleanup_gate_audit AFTER INSERT OR UPDATE ON source_media_gates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cleanup_require_audit();
CREATE CONSTRAINT TRIGGER cleanup_session_audit AFTER INSERT OR UPDATE ON source_media_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cleanup_require_audit();
CREATE CONSTRAINT TRIGGER cleanup_reservation_audit AFTER INSERT OR UPDATE ON media_key_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cleanup_require_audit();
CREATE CONSTRAINT TRIGGER cleanup_approval_audit AFTER INSERT OR UPDATE ON cleanup_approvals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cleanup_require_audit();

CREATE FUNCTION cleanup_scope_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op cleanup_operations; oid uuid; obj cleanup_objects; expected jsonb; actual_key text;
BEGIN
 oid := CASE WHEN TG_TABLE_NAME='cleanup_operations' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'operation_id')::uuid END;
 IF oid IS NULL AND TG_OP='UPDATE' THEN oid := (to_jsonb(OLD)->>'operation_id')::uuid; END IF;
 IF oid IS NULL THEN RETURN NULL; END IF;
 -- Serialize whole-operation validation. Unique keys and gate locks handle cross-operation conflicts.
 SELECT * INTO op FROM cleanup_operations WHERE id=oid FOR UPDATE;
 IF jsonb_typeof(op.manifest->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(op.manifest->'items')<>6 OR
   (SELECT count(*) FROM cleanup_objects WHERE operation_id=oid)<>6 OR
   (SELECT count(DISTINCT source_id) FROM cleanup_objects WHERE operation_id=oid)<>2 OR
   (SELECT count(DISTINCT project_id) FROM cleanup_objects WHERE operation_id=oid)<>2 THEN
   RAISE EXCEPTION 'CLEANUP_SIX_OBJECT_SCOPE_REQUIRED' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT source_id FROM cleanup_objects WHERE operation_id=oid GROUP BY source_id HAVING count(*)<>3 OR count(DISTINCT project_id)<>1) THEN
   RAISE EXCEPTION 'CLEANUP_SOURCE_SCOPE_INVALID' USING ERRCODE='23514'; END IF;
 FOR obj IN SELECT * FROM cleanup_objects WHERE operation_id=oid LOOP
   expected := op.manifest->'items'->obj.ordinal;
   IF expected IS DISTINCT FROM jsonb_build_object('sourceId',obj.source_id::text,'projectId',obj.project_id::text,'field',obj.field_name,
      'key',obj.storage_key,'bytes',obj.bytes,'sha256',obj.sha256,'etag',obj.etag,'headModifiedAt',obj.head_modified_at,
      'listModifiedAt',obj.list_modified_at,'metadata',obj.metadata) OR
      NOT isfinite(obj.head_modified_at::timestamptz) OR NOT isfinite(obj.list_modified_at::timestamptz) OR
      date_trunc('second',obj.head_modified_at::timestamptz)<>date_trunc('second',obj.list_modified_at::timestamptz) THEN
     RAISE EXCEPTION 'CLEANUP_MANIFEST_ITEM_MISMATCH' USING ERRCODE='23514'; END IF;
   SELECT to_jsonb(s)->>obj.field_name INTO actual_key FROM source_videos s JOIN projects p ON p.source_video_id=s.id
      WHERE s.id=obj.source_id AND p.id=obj.project_id AND s.workspace_id=op.workspace_id AND p.workspace_id=op.workspace_id;
   IF NOT FOUND OR (SELECT count(*) FROM projects WHERE source_video_id=obj.source_id)<>1 OR (obj.state='RECORD_COMMITTED' AND actual_key IS NOT NULL) OR
      (obj.state<>'RECORD_COMMITTED' AND actual_key IS DISTINCT FROM obj.storage_key) THEN
     RAISE EXCEPTION 'CLEANUP_SOURCE_REFERENCE_MISMATCH' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF (op.state IN ('READY','APPLYING','COMPLETE') OR EXISTS(SELECT 1 FROM cleanup_objects WHERE operation_id=oid AND state<>'PLANNED')) AND
    EXISTS(SELECT 1 FROM cleanup_objects o WHERE o.operation_id=oid AND NOT EXISTS(SELECT 1 FROM source_media_gates g WHERE g.source_id=o.source_id AND g.operation_id=oid AND g.state='RETIRED')) THEN
   RAISE EXCEPTION 'CLEANUP_RETIREMENT_REQUIRED' USING ERRCODE='23514'; END IF;
 IF op.state IN ('READY','APPLYING','NEEDS_RECONCILIATION') AND EXISTS(SELECT 1 FROM cleanup_objects o WHERE o.operation_id=oid AND NOT EXISTS(
    SELECT 1 FROM media_key_reservations r WHERE r.operation_id=oid AND r.storage_identity=op.storage_identity AND r.storage_key=o.storage_key AND r.state='HELD')) THEN
   RAISE EXCEPTION 'CLEANUP_RESERVATIONS_REQUIRED' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM cleanup_objects WHERE operation_id=oid AND state<>'PLANNED') AND op.state NOT IN ('APPLYING','NEEDS_RECONCILIATION','COMPLETE') THEN
   RAISE EXCEPTION 'CLEANUP_EXECUTION_STATE_REQUIRED' USING ERRCODE='23514'; END IF;
 IF op.state='ABORTED' AND (
    EXISTS(SELECT 1 FROM source_media_gates WHERE operation_id=oid) OR
    EXISTS(SELECT 1 FROM media_key_reservations WHERE operation_id=oid AND state='HELD') OR
    EXISTS(SELECT 1 FROM source_media_sessions s JOIN cleanup_objects o ON o.source_id=s.source_id WHERE o.operation_id=oid AND s.state<>'COMPLETE')) THEN
   RAISE EXCEPTION 'CLEANUP_ABORT_UNRESOLVED' USING ERRCODE='23514'; END IF;
 IF op.state='COMPLETE' AND EXISTS(SELECT 1 FROM cleanup_objects WHERE operation_id=oid AND state<>'RECORD_COMMITTED') THEN
   RAISE EXCEPTION 'CLEANUP_COMPLETION_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cleanup_scope_op AFTER INSERT OR UPDATE ON cleanup_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cleanup_scope_check();
CREATE CONSTRAINT TRIGGER cleanup_scope_obj AFTER INSERT OR UPDATE ON cleanup_objects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cleanup_scope_check();

CREATE CONSTRAINT TRIGGER cleanup_scope_gate AFTER INSERT OR UPDATE ON source_media_gates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cleanup_scope_check();
CREATE CONSTRAINT TRIGGER cleanup_scope_reservation AFTER INSERT OR UPDATE ON media_key_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cleanup_scope_check();

COMMIT;
