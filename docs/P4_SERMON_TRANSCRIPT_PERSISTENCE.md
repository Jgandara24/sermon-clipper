# Persisting a completed sermon submission

`persistSermonSubmission()` attaches a completed submission to a project that owns the same source.
It performs no provider request and reads no media file.
It validates the saved result checksum, provider evidence, source mapping, capabilities, and word intervals.
The submission must match the registered artifact and source.

Request admission now captures the source update time and transcript revision.
Persistence refuses a new transcript if either value changed after admission.
Older submission records without these fields cannot establish a safe write boundary.
They require separate recovery evidence.

The transaction locks the project and source in the existing writer order.
It preserves the existing durable-work reanalysis rule.
It advances the transcript revision and saves words, capabilities, complete provenance, and provider evidence.
It also creates the project's analysis job in that transaction.
An analysis handoff failure rolls back the transcript and revision.

The stored provider evidence identifies the completed submission.
Repeating the same save reuses the current transcript and its analysis job.
It does not advance the revision again.
A different project that shares the source receives its own analysis handoff.
The service does not replace edited or otherwise protected work through a new transcript.

The production transcription handler still uses its previous path.
Production orchestration must select the corridor and invoke registered submission before this persistence service.
Recovery and representative acceptance remain unfinished.

Optional measured structure now persists in the same transaction.
`buildSubmissionTranscriptStructure()` derives it from the durable response and checksummed sermon audio.
The persistence service validates word references, audio identity, source interval, and boundary derivation.
It records derived silence, sentence, and paragraph capabilities in the complete provenance document.
Repeated saves with different structure fail explicitly.
