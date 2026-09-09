# Local source and artifact measurements

Use this tool to inspect existing local media for P4 preparation. It does not create
derivatives, use a database, read cloud storage, or call a transcription provider.

```bash
npm run measure:local-media -- \
  --source /path/to/source.mp4 \
  --artifact /path/to/range.flac \
  --artifact-id local-audio-range-01 \
  --kind audio \
  --source-start-ms 500 \
  --source-end-ms 1500 \
  --output OUTPUTS/local-audio-range-01.json
```

`--kind` is `proxy`, `range`, or `audio`. The source must contain video. An `audio`
artifact must contain audio; a `proxy` or `range` artifact must contain video.
Use a new output filename. The command refuses to overwrite an existing report.

The start and end are milliseconds relative to the source presentation start.
They are a caller declaration. The tool checks that the declared interval fits
inside the source duration. It does not establish that the artifact contains
those source frames or words.

## Recorded facts

- SHA-256 checksum and byte count for each file.
- Container duration and start time.
- Video codec, dimensions, frame rate, stream start, and stream duration when present.
- Audio codec, channels, sample rate, stream start, and stream duration when present.
- Artifact duration minus the declared range duration.
- Artifact/source byte ratio and whether known video dimensions are equal.
- ffprobe and Node versions, platform, architecture, and inspection elapsed time.

The JSON omits input paths, filenames, tags, and raw ffprobe output. Use an opaque
artifact ID. Review the report before sharing it. Its checksum still identifies
the selected content.

## What the report cannot prove

Equal duration does not prove content alignment, exact source coverage, or correct
caption timing. Container and stream start times are observations, not a verified
source-content offset. Visual quality, caption accuracy, and content mapping stay
unreviewed or unverified in every report.

Inspection time measures hashing and probing existing files. It is not the time
needed to create a derivative. The tool does not measure derivation CPU, peak RAM,
peak disk, remote transfer, or provider cost. A shorter artifact's byte ratio is
not a fair encoding-efficiency comparison with the full source.

This is a measurement report, not a labeled benchmark manifest or a P2 proof. The
existing human-label and production-cost formats remain separate. No P4 settings
or acceptance threshold are selected by this tool.

## Local limits and validation

ffprobe must be on PATH. Child processes receive a small local environment with
no database or provider credentials. They have a hard timeout. Inputs must be
regular local files. Network URLs and playlist demuxers are refused. The tool
reads files without changing them and checks their identity, size, and modification
times again after inspection. A changed file requires a new measurement.

Supported container families are MOV/MP4, Matroska/WebM, MP3, WAV, FLAC, Ogg, AAC,
and MPEG-TS. Other formats require an explicit extension and regression test.

Unit tests cover parsing, separate clocks, range arithmetic, unknown frame rates,
and invalid declarations. A real local FFmpeg/CLI test creates a two-second
synthetic video and a one-second FLAC range. It checks measured facts, report
redaction, refusal of URLs/playlists, and refusal to overwrite the output.
