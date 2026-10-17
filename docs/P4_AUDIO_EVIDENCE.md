# Local audio evidence

`extractAudioEvidence()` measures the analysis audio.
It requires exactly one mono FLAC stream at 16,000 samples per second.
It refuses other formats instead of silently resampling them.
The detector selects only audio and disables video, subtitle, and data output.
It checks input checksum and byte count before and after processing.

The implementation uses FFmpeg `silencedetect`, `asetnsamples`, and `astats`.
The [FFmpeg filter reference](https://www.ffmpeg.org/ffmpeg-filters.html) describes these filters and their metadata.
The caller supplies the silence threshold, minimum silence duration, waveform window size, and execution limits.
No production thresholds follow from the generated fixtures.
Waveform windows cannot exceed the minimum silence duration.
This bound prevents multiple qualifying silence starts from overwriting metadata within one output window.

## Time and measurement

The detector preserves input timestamps and sets the audio time base to 1/16000.
It reads integer sample timestamps instead of rounded decimal timestamp text.
It rejects gaps between successive sample windows.
It maps observed timestamps into the declared source interval.
An interval overflow causes an error.

Each waveform window records its sample count, peak amplitude, and RMS amplitude.
Amplitudes use a linear scale where 1 represents full scale.
Digital silence produces zero amplitudes.
The detector does not pad the final waveform window.
The result retains the exact total sample count.
Source timestamps round to milliseconds.
A final window shorter than one millisecond can therefore have equal rounded start and end timestamps.
Its positive sample count remains authoritative.

Silence facts contain source-time intervals.
A detected end uses `DETECTED` as its end reason.
Trailing silence stops at the observed audio end and uses `OBSERVED_AUDIO_END`.
A longer declared source interval does not extend the observed silence.
Silence does not establish an absence of speech, music, or meaningful service content.
The detector does not select a sermon corridor.

## Identity and limits

Results include detector version, configuration hash, toolchain hash, settings, and input identity.
Configuration identity includes detection thresholds, waveform size, and thread count.
Execution timeout and metadata buffer limits do not alter content identity.
Malformed metadata, incompatible media, missing statistics, and changed inputs cause errors.

The current implementation buffers metadata and returns facts in memory.
The caller must supply a suitable memory limit.
Streaming output and production integration remain unfinished.
No production worker calls this function yet.

Seven real-media tests passed.
They cover silence, tone amplitude, source offsets, short final windows, interval bounds, and format rejection.
They also cover silence transitions, input identity, and configuration identity.
These fixtures do not establish production resource budgets or semantic classification accuracy.

The optional [local evidence batch](P4_LOCAL_EVIDENCE.md) now persists these facts in a registered JSON artifact.
Individual detector functions still return their facts in memory.
