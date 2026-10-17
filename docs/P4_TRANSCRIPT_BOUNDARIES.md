# Deterministic transcript boundaries

`deriveTranscriptBoundaries()` creates source-time sentence and paragraph facts from submitted-audio word timestamps.
It preserves every input word and its order.
It accepts overlapping words from different speakers.
It rejects backward word order, invalid intervals, and timestamps outside the submitted corridor.
The stored corridor start supplies the exact source offset.

Sentence endings use terminal punctuation, measured paragraph breaks, configured speaker changes, or the transcript end.
Closing quotation marks and brackets can follow terminal punctuation.
Callers supply literal nonterminal tokens, such as abbreviations.
Paragraphs use measured acoustic silence or configured changes between known speakers.
Unknown speaker labels do not create speaker changes.
Every span stores its word-index interval, source-time interval, and boundary reason.
Overlapping words retain their full end times.

Callers supply the paragraph silence threshold and speaker-change setting.
The function supplies no production threshold or language-specific abbreviation list.
It never treats missing transcript words as acoustic silence.
Missing acoustic evidence produces an unavailable silence capability.
Available acoustic evidence retains its checksum and measured intervals.

The result records `transcript-boundaries-v1` and a canonical input checksum.
The checksum binds words, audio identity, corridor, acoustic evidence, and settings.
Sentence and paragraph capabilities declare derived provenance.
These structural facts do not classify sermon content or forbidden regions.
The production transcription handler does not yet call this function.
Integration still needs submitted-artifact provenance, measured settings, persistence, and precise region classification.

Eight boundary tests and nine provenance tests passed.
They cover source offsets, acoustic evidence, missing evidence, overlap, punctuation, empty transcripts, invalid clocks, and stable provenance.
Type checking and focused lint passed.

## Measured and persisted structure

`buildSubmissionTranscriptStructure()` now reads the completed durable response and measures its selected sermon audio.
It checks the submitted audio checksum and exact source mapping.
Callers supply audio detector settings and boundary settings.
The helper derives structure from the saved display words, not replacement text from its caller.

Migration `20261016140000_transcript_structure` adds nullable `Transcript.structure`.
Historical transcripts keep null structure.
`persistSermonSubmission()` can now save structure with words, capabilities, provenance, and the analysis handoff.
It reconstructs boundaries from measured audio evidence and saved words before writing.
It rejects changed audio identity or inconsistent boundary facts.
A repeated save cannot silently replace existing structure with different settings.

The stored structure includes acoustic detector version, settings, toolchain, measured silence intervals, and input identity.
It also includes sentence and paragraph intervals, word-index ranges, and derivation provenance.
The transcript capability and provenance fields mark these facts as derived.
These facts still do not classify forbidden content.
Production orchestration and semantic region classification remain unfinished.

Forty-three database tests and 24 boundary, provenance, and audio tests passed.
Clean installation, populated upgrade, and repeated deployment checks passed in disposable databases.
Type checking, focused lint, and the worker build passed.
