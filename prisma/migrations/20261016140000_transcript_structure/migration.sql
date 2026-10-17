ALTER TABLE transcripts ADD COLUMN structure JSONB;
ALTER TABLE transcripts ADD CONSTRAINT transcript_structure_object CHECK (structure IS NULL OR jsonb_typeof(structure)='object');
