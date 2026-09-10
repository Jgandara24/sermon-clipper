# Local synthetic audio timing benchmark

```bash
npm run benchmark:local-audio-timing -- --output OUTPUTS/audio-timing.json
```

This command generates a four-second mono fixture on this computer. It compares
one audio energy event after encoding, resampling, and range extraction. It has
no input-media or URL option. It uses no database, storage provider, paid API,
application route, or worker job. It does not change the existing video benchmark.

Use a new report path in an existing directory. The command reserves that path
before work and refuses an existing file. A failed command, missing observation,
or event mismatch writes a failed report and exits nonzero. A filesystem failure
or abrupt termination can leave an incomplete reserved report.

FFmpeg and ffprobe must be on PATH. Creation CPU/RSS use the same native timer
as the [derivative benchmark](LOCAL_DERIVATIVE_BENCHMARK.md): system time on macOS
and GNU time on Linux. Missing metrics remain unavailable; no encoder is rerun
to obtain a metric. Its documented timer units and process-group limits apply.

## Fixture and generated files

The fixed fixture is `synthetic_audio_burst_v1`. It has 192,000 mono PCM samples
at 48 kHz. Samples 96,000 through 105,599 contain a 440 Hz sine with amplitude 0.5.
Other samples are zero. The declared event is 2,000–2,200 ms. The WAV origin comes
from this generation contract; it is not an observed container/stream start clock.
The report retains the generated PCM checksum and bytes separately.

| Stage | Result | Declared source interval |
| --- | --- | --- |
| PCM generation | Float32 WAV, 48 kHz | Generated sample origin |
| AAC source | AAC at 128 kbit/s, 48 kHz | Entire fixture |
| Same-rate derivative | FLAC at 48 kHz from AAC | 0–4,000 ms |
| Resampled derivative | FLAC at 16 kHz from AAC | 0–4,000 ms |
| Range derivative | FLAC at 16 kHz from AAC | 1,000–3,000 ms |

All parameters are fixture settings. They do not select production formats or
quality thresholds. Each derivative independently reads the local AAC source.
This is not a shared acquisition, cache, or coordinated production build test.

## Observed clocks and sample correspondence

Each AAC/FLAC observation retains a checksum, byte count, codec, sample rate,
container duration, and separate container/audio/first-frame starts. ffprobe
supplies decoded-frame timestamps and sample counts. The PCM decoder keeps the
native sample rate and mono channel layout. No inspection resampling is applied.

- Only zero-start mono AAC/FLAC at 48 or 16 kHz is supported. Missing or nonzero
  starts, other codecs/rates/channels, and missing frame clocks refuse. The tool
  does not invent WAV start clocks or normalize nonzero starts.
- Each frame's timestamp must agree with its cumulative sample offset within
  0.001 ms. This allows six-decimal-second clock rounding. Duplicate, backward,
  gapped, or drifting clocks cannot pass by using sample index alone.
- The decoded float32 sample count must equal the sum of probed frame samples.
  Nonfinite PCM or amplitudes outside this fixture's normalized range refuse.
- Container duration and decoded sample duration are separate facts. AAC can
  retain tail padding. The FLAC made from it can retain that longer duration.
  Extra samples alone do not prove that an event moved.

The report retains projected frame clocks/sample counts and RMS windows. Raw PCM,
unselected probe metadata, local input paths, and process output are omitted.

## Fixture event detector and comparison

The detector uses five-ms RMS windows. Each window's time is computed from its
actual decoded-frame timestamp plus its native-rate sample offset. Active RMS
is at least 0.1. Quiet RMS is at most 0.02. Intermediate windows refuse. These
parameters separated the generated fixture's burst from its encoded quiet signal;
they are not speech, music, or production quality classifiers.

Require one continuous burst of 200 ms ± one window and at least two complete
quiet windows on each side. Missing, repeated, ambiguous, or truncated events
cannot match. The detector observes an energy envelope, not the identity of all
audio content or the tone's spectral identity.

Validate the observed AAC source event against the declared fixture event. Then
subtract each derivative's declared source start and compare both boundaries.
The allowance is the sum of two window widths, two native sample periods, and
the measured source/output clock-rounding errors. Every result records the
allowance and both deltas. This bound describes fixture measurement uncertainty;
it is not a production synchronization target. A known 500 ms wrong range must fail.

Comparisons are `matched`, `mismatch`, or `unavailable`, with scope
`synthetic_audio_event_only`. The report always keeps source-content mapping and
audiovisual sync `NOT_VERIFIED`; audio quality and caption accuracy stay
`NOT_REVIEWED`. A match does not prove every sample, whole-interval coverage,
caption timing, word accuracy, or real-sermon quality. It supplies no P2 proof.

## Resources, failure handling, and tests

Creation wall time and native child CPU/RSS are separate from inspection wall
time. Each observation includes probe/decode time and total inspection time,
including file checks and hashing. Inspection CPU/memory remain `NOT_MEASURED`.
Retained media bytes are measured before cleanup; `peakDiskBytes` remains null.
No remote transfer or production cost is measured.

Children receive an allowlist environment without provider/database credentials.
Commands use direct argument arrays. Each creation/probe/decode has a ten-second
limit and the existing one-MiB combined-output limit. An owned process group is
stopped on timeout or excess output. Inspection accepts local regular fixtures
of at most two MiB, 1,024 probed frames, 262,144 decoded samples, and six seconds
of decoded audio. A limit failure cannot become a partial match.

Success and handled failure remove only this run's media. Unrelated files remain.
A hard crash can leave temporary files; this tool adds no orphan sweep. Generated
media is not retained for a human quality review.

Unit tests cover frame/sample correspondence, rounding, missing/nonzero clocks,
unsupported streams, invalid PCM, ambiguous events, and wrong mappings. Actual
CLI/FFmpeg tests cover same-rate and resampled paths, encoded wrong ranges,
missing/repeated events, nonzero starts, encoder/probe/decode failure, report
redaction, no-overwrite behavior, rejected inputs, and owned cleanup. These are
engineering tests, not approval to change production or implement P4 behavior.
