# Preserved transcript provider evidence

`Transcript.providerEvidence` stores Scribe response evidence separately from display words.
Migration `20261016120000_transcript_provider_evidence` adds this nullable JSON column.
Historical transcripts retain null values.

The Scribe parser now preserves every returned word, spacing entry, and audio event.
It retains original second-based timestamps, speaker labels, and supplied log probabilities.
Missing log probabilities remain null in this evidence.
Display words retain their previous normalization for compatibility.
The evidence therefore distinguishes provider timestamps from adjusted display timestamps.
Invalid or nonfinite evidence fails before JSON persistence.

The evidence records provider, model version, language probability, and `scribe-response-evidence-v1`.
`sourceOffsetMs` maps the submitted audio clock to the source clock.
Offset mapping updates this field without changing original provider timestamps.
The transcription transaction stores evidence with the words and analysis handoff.

This evidence is not complete submission provenance.
Submitted artifact checksums, provider request identity, capability persistence, structural boundary persistence, and region classification still need integration.
The new evidence does not claim those fields exist.

Thirty provider, offset, and selection tests passed.
Eight transcript database tests passed, including stored original clocks and audio events.
The database test uses an injected Scribe response and makes no paid request.
Clean installation, populated upgrade, and repeated deployment checks passed in disposable local databases.
Historical data, search, source revision, and workspace defaults remained unchanged.
Type checking, focused lint, and the worker build passed.

## Display field capabilities

Provider evidence now contains `displayCapabilities`.
Adjusted display timestamps declare `scribe-display-timestamps-v1` and the provider-evidence checksum.
Confidence derived from supplied log probabilities declares `scribe-exp-logprob-clamped-v1`.
If any word lacks a log probability, the confidence capability declares unavailable.
Legacy display confidence defaults do not count as measured confidence.
Incomplete speaker labels also declare unavailable, while original labels remain in provider evidence.
Audio-event evidence declares its native provider and model.
Silences, sentences, paragraphs, and subword confidence remain unavailable until their evidence exists.

The complete transcript capability and provenance columns remain null together.
The database still requires both columns for complete submission provenance.
These partial display facts do not bypass that requirement.
Three capability tests, 21 provider/provenance tests, and eight database tests passed.
