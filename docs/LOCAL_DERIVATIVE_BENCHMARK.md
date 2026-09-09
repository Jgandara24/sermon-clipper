# Local synthetic derivative benchmark

Use this command to prepare P4 measurements on macOS or Linux:

```bash
npm run benchmark:local-derivatives -- --output OUTPUTS/derivative-benchmark.json
```

The command creates a four-second test source, then a proxy, an audio file, and a
range file. It accepts no source file or URL. It uses no database, storage provider,
production media, or paid API. It has no app or worker caller.

FFmpeg and ffprobe must be on PATH. Linux resource measurements need GNU time at
`/usr/bin/time`. If that timer is absent, creation can still run, but CPU and memory
remain unavailable. The application and worker images do not need this tool.

Use `--duration-seconds <integer>` to select 2–10 seconds. Use a new report path.
The command reserves that path before work and refuses to replace an existing
file. The output directory must exist. A failed benchmark writes a failed result
and exits with a nonzero code. A filesystem failure or abrupt process termination
can leave an incomplete report; inspect it and use a new path for a later run.

## Test artifacts

All settings below are experimental fixture parameters. They are not production
defaults or quality recommendations. The report records the complete FFmpeg
argument arrays. Temporary paths are replaced with artifact labels.

| Stage | Result | Declared source interval |
|---|---|---|
| Source generation | 640×360, 30 fps test pattern, sine audio, H.264/AAC | Entire generated source |
| Proxy | 320×180 H.264/AAC | Entire source |
| Audio | Mono 16 kHz FLAC | Entire source |
| Range | 640×360 H.264/AAC | Middle half of the source |

A red box appears halfway through the generated source. It is a test marker.
The command can inspect that event with `--observe-marker`. Without this option,
no marker check runs. The full interval remains declared and unverified in both
modes. Each artifact independently reads the source.
This does not measure a shared download cache or a coordinated derivative build.

## Optional synthetic marker timing

```bash
npm run benchmark:local-derivatives -- --output OUTPUTS/marker-benchmark.json --observe-marker
```

This option checks one generated video event in the source, proxy, and range.
It does not inspect the audio derivative. A default four-second fixture should
show the marker at 2,000 ms in source and proxy, and 1,000 ms in the range. The
comparison uses the observed source event minus the declared range start. It also
checks the source event against the fixture's intended marker time.

The `markerTiming` field keeps separate observations and comparisons. A comparison
is `matched`, `mismatch`, or `unavailable`. If a requested comparison is not matched,
the benchmark records `marker_observation_failed` and exits nonzero. The observations
and successful creation measurements remain in the report. Owned media cleanup
still runs. Omitting the option leaves `requested: false` and empty marker lists.

- ffprobe supplies each decoded video's `best_effort_timestamp_time`. The report
  retains those frame times, sampled red-pixel counts, and separate container,
  video, and first-frame starts. It never substitutes frame indices for timestamps.
- This fixture supports only zero container/video/first-frame starts and constant
  30 fps. Nonzero starts are reported and refused; they are not normalized by guess.
  Duplicate, backward, missing, and variable frame times are refused. A 0.002 ms
  cadence allowance covers rounding of ffprobe's six-decimal-second timestamps.
- The crop is 80×80 at the source/range upper left and 40×40 in the half-size proxy.
  FFmpeg area-scales it to 8×8 RGB24. A pixel qualifies at R≥220, G≤40, B≤40. Presence
  requires all 64 pixels; absence requires at most 32. At least two absent frames
  must precede at least two present frames. Intermediate or flickering states refuse.
  These settings describe this fixture only; they do not classify sermon content.
- Decoding preserves frame cadence. The decoded frame count must equal the probed
  timestamp count. The file identity and size/time metadata must remain unchanged
  during inspection. Each probe/decode is limited to 10 seconds and one MiB of output.
  Only local regular MP4 fixtures of at most 50 MiB and 360 probed frames are accepted.
  Decoding stops at 361 frames so an excessive output cannot be a partial match.
- Event tolerance is one measured frame interval, using the larger source/output
  interval. This covers event quantization for fractional range starts. It is not a
  production synchronization target. A match cannot prove every frame, a whole
  interval, audio alignment, caption timing, or real-sermon quality.

Marker inspection reports probe/decode and total wall time separately from media
inspection and creation. Marker inspection CPU and memory remain `NOT_MEASURED`.
Raw pixels, probe metadata, process output, and temporary paths are not copied into
the report. Projected frame times and red-pixel counts are retained for review.

## Measurements and scope

Each creation stage records its outcome, launcher exit code/signal, elapsed time,
user CPU time, system CPU time, and peak resident set size. The monotonic elapsed
timer surrounds process launch through close. CPU and memory describe the timed
command through OS resource accounting. They do not describe the Node parent.
The timer's exit status is propagated from its command; a signal value describes
the launched timer process, not necessarily a signal received by FFmpeg.

- On macOS, `/usr/bin/time -l` supplies CPU seconds and maximum RSS in bytes.
  The installed `time(1)` manual defines `-l` as a resource-usage report. The
  installed `getrusage(2)` manual defines `ru_maxrss` in bytes.
- On Linux, GNU `/usr/bin/time` supplies `%U`, `%S`, and `%M`. CPU seconds become
  milliseconds. RSS in KiB becomes bytes. See the GNU manuals for
  [CPU fields](https://www.gnu.org/software/time/manual/time.html) and
  [memory fields](https://www.gnu.org/software/time/manual/html_node/Memory-Resources.html).
- The tool probes the native timer before encoding. A missing or unsupported
  timer leaves resources `unavailable` with a reason. It does not rerun FFmpeg.
  Invalid or incomplete metrics are also unavailable. Missing memory is never zero.
- Native CPU fields have limited precision. A measured `0.00` can represent a
  duration below that precision. RSS is the OS maximum for the command. It is not
  host memory use or a simultaneous sum of a process tree.

The tool does not parse FFmpeg's `-benchmark` memory label. That label requires
version and platform interpretation and can differ from the native byte unit.

After creation, the existing local inspection tool records source/artifact
checksums, byte counts, dimensions, durations, clocks, and ffprobe versions. Those
inspection times remain separate from creation times. A shorter range's byte
ratio is not an equal-duration encoding comparison or a quality-adjusted saving.

The total retained media bytes are measured after all four files exist. This is
not peak disk use, allocated filesystem blocks, transfer bytes, or a cache test.
`peakDiskBytes` stays null. No price or production cost ledger entry is created.

## Failure handling and evidence limits

Child processes receive an allowlist environment without provider or database
credentials. They receive no shell command. Each encoding has a 60-second limit
and a one-MiB combined output limit. On timeout or excess output, the tool stops
the owned process group, including the timer and its command. It records failure
without copying raw process output into the report.

The tool creates a new owned temporary directory. Normal success and handled
failures remove that directory. The cleanup result is explicit. It never deletes
another run's files. A hard crash can leave temporary files; no orphan sweep is
implemented. Generated media is not retained for human review.

Parser tests cover units, missing/ambiguous metrics, and zero values. Real command
tests cover artifact facts, native measurements, failed encoding, output limits,
process-group timeout, temporary cleanup, report overwrite refusal, and rejected
external input. Tests do not prove real-sermon quality or production resource use.
Marker tests cover correct source/proxy/range events, duration bounds and an odd
duration, an encoded wrong range with unchanged declared mapping, absent/flickering
markers, nonzero starts, unavailable clocks, extraction counts, and frame cadence.
Known bad or unavailable observations cannot receive a marker match.

Every report keeps visual quality and caption accuracy `NOT_REVIEWED` and content
mapping `NOT_VERIFIED`. This benchmark does not complete a P2 proof, select P4
settings, authorize deployment, or replace the measured P0/P2 planning gate.
