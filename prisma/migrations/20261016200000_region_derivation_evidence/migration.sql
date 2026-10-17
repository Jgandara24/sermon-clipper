-- Nullable evidence preserves historical detector facts. The existing trigger protects this column from updates.
ALTER TABLE media_regions ADD COLUMN derivation_evidence JSONB;
ALTER TABLE media_regions ADD CONSTRAINT media_region_derivation_evidence_object CHECK (
  derivation_evidence IS NULL OR
  (jsonb_typeof(derivation_evidence) = 'object' AND derivation_evidence <> '{}'::jsonb)
);
