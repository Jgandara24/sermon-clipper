# Consecutive scripture slide groups

`recordSlideRegionBatch` stores slide facts and derived `VERSE_SLIDESHOW` facts in one transaction.
It takes the existing source lock and checks workspace ownership.
An insertion failure rolls back both input slides and derived groups.
Repeated or concurrent batches reuse the same immutable records.

Each batch must contain distinct, non-overlapping `FULLSCREEN_SLIDE` intervals.
All input facts must share a source checksum, detector version, and detector configuration.
Input order does not change grouping or evidence identity.
Each group requires at least two consecutive `SCRIPTURE` slide facts.
Another slide subtype ends the current group.
A gap larger than the supplied `maxGapMs` also ends the group.
The service requires `maxGapMs`; it supplies no default.
Measured evidence must support production gap settings.

Group intervals cover their first slide through their last slide.
The group therefore includes any explicitly permitted gap.
Group confidence uses the minimum input confidence.
This rule does not establish calibrated confidence or detector accuracy.
The service performs no OCR, visual inference, or scripture recognition.
Its caller must supply distinct slide intervals with reliable classifications.

The additive migration adds nullable `MediaRegion.derivationEvidence`.
Historical facts retain null evidence.
The existing immutable-row trigger protects the new column.
Group evidence records parent identity keys, source identity, detector configuration, gap settings, and confidence aggregation.
Its checksum must match the group's `evidenceSha256` before persistence.
Parent facts remain available through their retained identities.
Project deletion does not remove source-owned groups.

Existing export checks reject `VERSE_SLIDESHOW` overlap.
Existing publication checks and late review exceptions also apply.
The batch service does not activate a detector or modify transcript audio.
Production detector integration and representative classification evidence remain unfinished.

All 25 focused tests and 15 database cases passed.
Database tests covered concurrent retries, atomic rollback, immutable evidence, and source ownership after project deletion.
The database run also checked existing region registration and late publication exceptions.
Tests used a temporary database and synthetic facts.
They do not establish real slide recall or production acceptance.
