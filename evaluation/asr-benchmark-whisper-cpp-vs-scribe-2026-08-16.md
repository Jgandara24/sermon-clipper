# ASR benchmark: whisper.cpp production path vs Scribe v2 — 2026-08-16

## Current decision

Use base Scribe v2 as the primary **pilot** provider. Do not enable paid keyterm prompting by
default. Keep whisper.cpp as the local fallback for privacy, provider outages, and cost control.

Scribe corrected all seven targeted church-language errors found in the whisper.cpp output both
with and without keyterms. Its word starts also closely matched the separate forced-alignment
result. Scribe completed the full 47-minute sermon in about 45 seconds. The current whisper.cpp
path needed about eight minutes.

Do not make the production switch until a person labels at least 250 words and verifies the
accuracy gates in this report. The current SRT is automated. It cannot prove a final word error
rate.

## Priority rule

1. Reject a provider that does not meet the transcript and timestamp accuracy gates.
2. Among providers that meet the gates, choose the least expensive provider.

Low cost must not compensate for inaccurate captions.

## Test input and production configuration

| Item | Value |
| --- | --- |
| Source | `21801cb4-e8c4-40db-acf0-aabac6cc89e8-sermon.mp4` |
| Duration | 2,820.458 seconds (`47:00.458`) |
| Input audio | Mono 16 kHz PCM WAV, the same form used by the worker |
| whisper.cpp | 1.9.1 |
| Model | `ggml-base.en.bin` |
| Model checksum | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` |
| Command behavior | Four default threads, English model, full JSON token output |
| Machine | Intel Core i7-9750H, six physical cores, 16 GiB RAM |

The benchmark used the exact model, binary version, and command options configured by the worker.
Production code was not changed.

## whisper.cpp runtime and cost

| Metric | Result |
| --- | ---: |
| Wall time | 483.51 seconds (`8:03.51`) |
| Throughput | 5.83 times faster than real time |
| CPU time | 2,126.08 CPU-seconds |
| Peak resident memory | 937,623,552 bytes (about 938 MB) |
| Model size | about 141 MiB |
| Output segments | 829 |
| Output words after the production token merger | 7,886 |

Using Railway's listed CPU and RAM rates, the conservative marginal estimate is about **$0.018
per 47-minute sermon**. This does not include the worker's base or idle cost.

Railway pricing source: <https://docs.railway.com/pricing/plans>.

## Transcript-text evidence

The whisper.cpp transcript has 95.09% word-sequence agreement with the existing automated SRT.
The disagreement rate is 4.91%, or 391 edits against 7,966 normalized SRT words.

This is not a true word error rate. The SRT is also machine-generated and contains errors. It is
useful for finding review samples, not for declaring either transcript correct.

The production whole-word confidence results are:

| Metric | Result |
| --- | ---: |
| Mean confidence | 0.920 |
| Median confidence | 0.984 |
| Confidence at least 0.70 | 7,221 words (91.57%) |
| Confidence below 0.50 | 166 words (2.10%) |
| Confidence below 0.20 | 7 words (0.09%) |

High model confidence does not guarantee correct church vocabulary. Several likely errors have
high contextual plausibility but change the meaning.

## Human-check samples

These disagreements were used for the direct provider comparison:

| Time | Existing SRT | whisper.cpp | Scribe v2, with or without keyterms |
| --- | --- | --- | --- |
| `03:03` | `Psalm` | `the long song` | `Psalm 139` |
| `09:37` | `an ounce` | `the pronounce` | `an ounce` |
| `16:19` | `thus saith` | `let's say at` | `Thus saith` |
| `18:43` | `Methodist` | `method is` | `Methodist` |
| `31:20` | `Jehovah Jireh` | omitted near repeated `yeah` | `Jehovah Jireh` |
| `35:54` | `did and helped` | `didn't help` | `did and helped` |
| `37:21` | `Ananias and Sapphira` | `anisins to fire` | `Ananias and Sapphira` |

The `did and helped` / `didn't help` case is important because it can reverse the meaning. The
name and scripture cases are good tests for Scribe keyterm prompting.

## Native whisper.cpp timestamp structure

| Metric | Result |
| --- | ---: |
| Word-start regressions | 0 |
| Adjacent word overlaps | 4 |
| Median word duration | 160 ms |

The timestamps are structurally much better than the imported SRT timestamps. Structure does not
prove that each start is on the spoken word.

## whisper.cpp plus forced alignment

The same whisper.cpp transcript was passed through WhisperX with the English Wav2Vec2 alignment
model. This comparison tests how much an acoustic alignment pass changes native token times. It is
not a human-labeled accuracy measurement.

| Metric | Result |
| --- | ---: |
| Alignment wall time | 255.71 seconds (`4:15.71`) |
| Alignment model inference | 234.54 seconds (`3:54.54`) |
| Peak resident memory | 1.33 GB |
| Estimated added Railway cost | about $0.012 |
| Combined whisper.cpp plus alignment cost | about $0.030 |
| Exact matched and timed words | 7,831 of 7,886 (99.30%) |

Word-start changes between native whisper.cpp and forced alignment:

| Absolute change | Result |
| --- | ---: |
| Median | 203 ms |
| 90th percentile | 805 ms |
| 95th percentile | 1,069 ms |
| At least 100 ms | 5,466 words (69.80%) |
| At least 250 ms | 3,415 words (43.61%) |
| At least 500 ms | 1,743 words (22.26%) |
| At least 1 second | 472 words (6.03%) |

This difference is too large to assume that native timestamps are “ultra precise.” It is also too
large to replace them blindly without a human timing reference.

## Scribe v2 verified facts

ElevenLabs currently lists Scribe v2 at **$0.22 per audio hour**. The batch API supplies word-level
timestamps, up to 32-speaker diarization, and audio-event tags. Keyterm prompting costs an
additional **$0.05 per audio hour** at the published rate.

Official sources:

- Pricing: <https://elevenlabs.io/pricing/api?price.section=speech_to_text>
- Capabilities: <https://elevenlabs.io/docs/overview/capabilities/speech-to-text>
- API fields: <https://elevenlabs.io/docs/api-reference/speech-to-text/convert>

For this 47-minute sermon:

| Provider path | Estimated source cost |
| --- | ---: |
| whisper.cpp | $0.018 |
| whisper.cpp plus forced alignment | $0.030 |
| Scribe v2 | $0.172 |
| Scribe v2 with keyterms | $0.212 |

At 100 sermons of the same length, the estimated marginal costs are about `$1.82`, `$2.99`,
`$17.24`, and `$21.15`, respectively.

Scribe costs about 10 to 12 times more than whisper.cpp for ASR alone. The absolute difference is
about 19 cents per sermon when keyterms are enabled. Scribe also replaces separate work for
speaker diarization and audio-event detection, so the total system-cost gap is smaller than the
ASR-only comparison suggests.

ElevenLabs processes files longer than eight minutes in parallel chunks. The documentation does
not give a guaranteed batch completion time. The direct call for this sermon completed in about
45 seconds.

## Scribe v2 direct result

The request used the same sermon audio with English word timestamps, diarization, audio-event
tags, and the keyterms listed below. It returned successfully in **44.98 seconds**.

| Metric | Scribe v2 result |
| --- | ---: |
| Wall time | 44.98 seconds |
| Speed relative to source | about 62.7 times faster than real time |
| Normalized transcript words | 8,132 |
| Timestamped word items | 8,113 |
| Word-start regressions | 0 |
| Adjacent word overlaps | 25 |
| Median word duration | 140 ms |
| Median reported word confidence | 0.999997 |
| Speakers returned | 4 |
| Audio-event items | 92 |
| Estimated request cost | about $0.212 |

The Scribe transcript has 93.23% word-sequence agreement with the automated SRT. The whisper.cpp
result has 95.09% agreement. This does **not** show that whisper.cpp is more accurate. Scribe kept
more fillers and spoken fragments, and the SRT is not a human reference. On the seven targeted
meaning and church-language cases, Scribe was correct in all seven. whisper.cpp was wrong in all
seven.

Scribe word timing was compared with the separate forced-alignment outputs. These are agreement
measurements, not human timing error measurements.

| Comparison | Matched words | Median start difference | Within 50 ms | Within 100 ms | 95th percentile |
| --- | ---: | ---: | ---: | ---: | ---: |
| Scribe vs native whisper.cpp | 7,541 | 214 ms | 15.02% | 29.78% | 1,182 ms |
| Scribe vs forced-aligned whisper.cpp | 7,499 | 15 ms | 90.24% | 94.63% | 120 ms |
| Scribe vs forced-aligned SRT | 7,622 | 15 ms | 87.46% | 92.05% | 458 ms |

This is strong evidence that Scribe word starts are much closer to acoustically aligned speech
than the native whisper.cpp starts. A person must still mark exact word starts before the final
timing gate can pass.

The diarization output is not ready to ship without cleanup. Scribe returned four speaker IDs,
but it split the main preacher across at least two IDs. This is likely related to long-file chunk
processing. Add speaker stitching before using these IDs in the editor. The 92 audio-event items
also need normalization and a human quality check.

## Keyterm A/B result

The same audio was sent to Scribe v2 a second time with the same settings and no keyterms. The
no-keyterm request completed successfully in **47.77 seconds** at an estimated cost of **$0.172**.

| Metric | With keyterms | Without keyterms |
| --- | ---: | ---: |
| Wall time | 44.98 seconds | 47.77 seconds |
| Normalized words | 8,132 | 8,135 |
| Agreement with automated SRT | 93.23% | 93.18% |
| Adjacent timestamp overlaps | 25 | 18 |
| Median start difference from forced-aligned whisper.cpp | 15 ms | 15 ms |
| Within 50 ms of forced-aligned whisper.cpp | 90.24% | 90.44% |
| Targeted difficult phrases correct | 7 of 7 | 7 of 7 |

The two Scribe outputs matched on 8,086 normalized words and had 99.42% sequence similarity. They
differed in 51 small blocks. Most differences were fillers, audience responses, partial words, or
minor alternatives such as `sit` versus `sat`. Keyterms did not improve any of the seven targeted
church-language phrases. Timing performance was effectively equal.

Base Scribe v2 is therefore the better default for this pilot. It preserves the measured quality
and avoids the keyterm surcharge. Allow keyterms later only for known church-specific proper nouns
when metadata or a larger benchmark proves that they improve accuracy.

## Transcript retention decision

Keep one canonical transcript for the complete sermon section. Do not limit the stored transcript
to the selected clips, and do not transcribe each clip again. The canonical record must preserve
the full sermon text, segment and word timestamps, confidence data, source-video time offsets,
provider name, model version, and transcription configuration.

Every clip must reference its range in this canonical sermon transcript. Future features can reuse
the same record without another transcription charge. A later text-post generator is one expected
use. It could create written posts from selected sermon passages while retaining a direct link to
the original spoken words and times.

“Complete sermon” does not mean “complete church service.” Worship, announcements, baptism,
prayer, altar call, and other excluded service sections should be removed by the sermon-boundary
flow before the paid Scribe request whenever the boundary can be determined safely.

## Privacy constraint

Scribe sends church audio to ElevenLabs. Logging is enabled by default. ElevenLabs documents zero
retention mode for Enterprise customers only. A non-Enterprise integration needs clear customer
terms, a deletion workflow, and a retention review.

Official retention source:
<https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode>.

## Direct comparison configuration

The direct Scribe v2 request used:

- `model_id=scribe_v2`
- `language_code=en`
- `timestamps_granularity=word`
- `diarize=true`
- `tag_audio_events=true`
- `no_verbatim=false`
- one request with the benchmark keyterms below
- one request with no keyterms

The benchmark keyterms were `Psalm`, `thus saith`, `Methodist`, `Jehovah
Jireh`, `Ananias and Sapphira`, `Holy Spirit`, `fear of the Lord`, `omnipresence`, and `Pharaoh`.

## Accuracy gates

Create a human-labeled sample of at least 250 words. Stratify it across quiet speech, fast speech,
crowd response, pauses, names, scripture references, and the disagreements listed above.

The provider must meet all of these gates:

1. Overall word error rate at most 3% on the labeled sample.
2. No meaning-reversing error in the sample.
3. Named-person, church, and scripture-term accuracy at least 98% with available metadata.
4. Every displayed word has a start and end time after fallback processing.
5. Median word-start error at most 80 ms.
6. 95th-percentile word-start error at most 150 ms.
7. Zero timestamp regressions and zero active-word overlaps after normalization.
8. Speaker and audio-event output passes a separate human review before editorial features use it.

## Benchmark recommendation

Base Scribe v2 is the best primary pilot path for the stated priority: highest accuracy first,
then affordability. It corrected the important transcript errors without keyterms, supplied much
better word timing, and finished more than ten times faster. About 17 cents for a 47-minute sermon
is affordable for a quality-first product.

Store the full canonical sermon transcript for reuse by clip captions, selection, search, and
later transcript-based products. Keep keyterm support available, but enable it only for known
church-specific names or when evidence shows a measurable accuracy gain.

Keep whisper.cpp as the fallback. Do not add WhisperX forced alignment to production now. Scribe
already produced timing close to the forced-alignment result without the extra local pass.

Before the provider switch:

1. Create the 250-word human-labeled accuracy and timing set.
2. Normalize small timestamp overlaps.
3. Add speaker stitching across long-file chunks.
4. Review audio-event tags before showing them in the editor.
5. Complete the customer-data retention review.
