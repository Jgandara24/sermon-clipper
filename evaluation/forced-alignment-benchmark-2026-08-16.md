# Forced-alignment benchmark — 2026-08-16

## Decision

Proceed with a guarded production trial for imported SRT transcripts. Do not replace all word
times without fallback logic and a human-labeled accuracy gate.

The benchmark shows a large timing improvement over the current SRT interpolation. The pass is
low-cost and fits the worker memory limit. It adds about 9 minutes per 47-minute sermon on the
six-core test machine. A four-vCPU worker will probably need about 14 minutes. Treat that value as
an estimate until it is measured on Railway.

## Test input

| Item | Value |
| --- | --- |
| Project | `Validation — real 47min sermon` |
| Source video | `21801cb4-e8c4-40db-acf0-aabac6cc89e8-sermon.mp4` |
| Duration | 2,820.458 seconds (`47:00.458`) |
| Source size | 158,665,289 bytes (about 151 MiB) |
| Audio | AAC LC, 44.1 kHz, stereo; extracted to mono 16 kHz PCM |
| Transcript provider | `srt_upload` |
| Transcript | 1,160 cues and 7,956 words |

The SRT is a rolling-caption file. Adjacent cue display windows overlap. The current database word
times divide each full cue into equal word spans. They are estimated times, not acoustic word times.

## Method

- Tool: WhisperX 3.3.1 forced alignment only. The test did not transcribe the audio again.
- Acoustic model: torchaudio `WAV2VEC2_ASR_BASE_960H`.
- Device: CPU.
- Machine: Intel Core i7-9750H, six physical cores, 16 GiB RAM.
- Input text: the exact existing transcript text.
- Comparison baseline: the exact word timestamps stored in Postgres.
- Production code was not changed. All model and runtime files stayed in a temporary directory.

## Runtime and resource results

| Metric | Result |
| --- | ---: |
| Audio extraction | 6.12 seconds |
| Cold import | 12.41 seconds |
| Cold model download and load | 98.45 seconds |
| Forced alignment | 534.61 seconds (`8:54.61`) |
| Cold end-to-end Python pass | 646.48 seconds (`10:46.48`) |
| Measured cold wall time | 649.00 seconds (`10:49.00`) |
| Cached model load | 2.04 seconds |
| Estimated warm end-to-end pass | about 552 seconds (`9:12`) |
| Alignment real-time factor | 0.190× source duration |
| Peak resident memory | 1,257,160,704 bytes (about 1.26 GB) |
| Model file | about 360 MiB |
| Temporary Python environment | about 1.7 GB, excluding the model |

The current production guide recommends four vCPUs and 4 GB RAM. A simple core-count projection
puts alignment near 13:22 on four vCPUs, plus about 17 seconds for warm startup and audio loading.
CPU scaling and Railway hardware can change this result.

## Timing-quality results

| Metric | Current SRT timing | Forced alignment |
| --- | ---: | ---: |
| Words with measured acoustic times | 0 | 7,905 of 7,956 (99.36%) |
| Adjacent word overlaps | 1,094 (13.75%) | 80 (1.02%) |
| Word-start order regressions | 1,054 (13.25%) | 20 (0.25%) |
| Median word duration | 564 ms | 141 ms |

The remaining 51 untimed words are numeric tokens such as `4:8`, `1996`, `25:14`, and `90%`.
The English alignment dictionary does not contain digit characters. Production must convert these
tokens to spoken words for alignment, then map them back to the displayed token. It must keep a
safe fallback when conversion is ambiguous.

The forced-aligned word starts changed substantially from the current stored times:

| Absolute start-time change | Result |
| --- | ---: |
| Median | 729 ms |
| 90th percentile | 2,052 ms |
| 95th percentile | 2,509 ms |
| At least 100 ms | 7,002 words (88.58%) |
| At least 500 ms | 4,881 words (61.75%) |
| At least 1 second | 2,978 words (37.67%) |
| At least 2 seconds | 846 words (10.70%) |
| Largest observed change | 5.289 seconds |

The large changes are expected for this rolling SRT. The current system spreads words across long,
overlapping display windows. The acoustic model places them on their detected speech sounds.

## Alignment confidence

| Metric | Result |
| --- | ---: |
| Mean score | 0.765 |
| Median score | 0.840 |
| Score at least 0.70 | 6,113 words (77.33%) |
| Score below 0.50 | 1,030 words (13.03%) |
| Score below 0.20 | 452 words (5.72%) |

The model score is useful for fallback decisions. It is not a direct millisecond-error measure.

## Cost estimate

The local pass has no model API fee. It uses worker CPU, memory, and model storage.

Railway currently lists CPU at `$0.000463 / vCPU / minute`, RAM at
`$0.000231 / GB / minute`, and volume storage at `$0.15 / GB / month`:
<https://docs.railway.com/pricing/plans>.

The measured run used 3,057.57 CPU-seconds. At Railway's listed CPU rate, that is about `$0.0236`.
Using peak memory for the full cold wall time gives a conservative memory estimate of `$0.0031`.
The total conservative estimate is therefore about **$0.027 per 47-minute sermon**, or about
**$2.67 per 100 sermons**. The 360 MiB cached model adds about `$0.05 per month` in volume storage.

This is an estimate, not a Railway invoice measurement. Shared-CPU performance, actual memory
metering, and worker idle time can change the production cost.

## Limits of this benchmark

- There is no human-labeled word-boundary file for this sermon. This test proves coverage,
  consistency, runtime, and the size of corrections. It does not prove exact timing error in
  milliseconds.
- The source is an imported rolling SRT. Native whisper.cpp word timestamps may have a smaller
  improvement. Benchmark that path separately before enabling forced alignment for every source.
- The temporary dependency set adds about 2.1 GB with the model. Production should use a pinned,
  optimized image or a separate alignment worker.
- This WhisperX version emits macOS duplicate-FFmpeg-library warnings. They did not stop the run,
  but the production Linux image still needs its own build and smoke test.

## Production requirements before rollout

1. Run forced alignment as a background job. Do not run it during an editor Save action.
2. Start with `srt_upload` transcripts. Keep whisper.cpp timestamps unchanged until a second
   benchmark shows a clear benefit.
3. Normalize numbers, times, percentages, and scripture references to spoken text before alignment.
   Map the aligned times back to the original display token.
4. Interpolate low-confidence or untimed words between reliable neighboring words.
5. Apply a final monotonic pass so word starts never move backward and active windows never overlap.
6. Store the model name, version, score, runtime, CPU time, and fallback count with the job.
7. Give the stage its own heartbeat and at least a 30-minute timeout on the four-vCPU worker.
8. Create a 200-word human-labeled set before general release. Require zero missing final times,
   zero regressions, median start error at most 80 ms, and 95th-percentile start error at most
   150 ms.
9. Run mandatory render QC after alignment. It must catch blank captions, missing fonts, and timing
   gaps before export delivery.

## Recommendation

Build the guarded SRT path next. The measured cost is small, the memory fits the current worker
target, and the current SRT interpolation is not accurate enough for word highlighting. Do not call
the feature “ultra precise” until the human-labeled gate passes.
