# Sparse OCR execution

`runSparseOcr` reads selected representative image files.
It does not open source video or run OCR on every sampled frame.
Each selection must identify an available representative group and its exact frame checksum.
Each selection also requires `LIKELY_STATIC_TEXT` evidence and its checksum.
The adapter checks these references but does not independently prove that classification.

The adapter rejects duplicate groups, missing representatives, changed images, and excessive input bytes.
It limits selected frames and total TSV output bytes.
Every child process has a timeout and output limit.
It verifies the mounted model before inference.
Production use requires the existing `/models` path and model approval evidence.
The caller must keep the model volume read-only during execution.

The adapter reads only the language file that passed verification.
It uses the LSTM engine and requires an explicit page segmentation mode.
It requests TSV through a runtime setting without relying on an unverified configuration file.
It checks the image checksum again after OCR.
A child failure or changed image stops the batch without a partial result.

Each result records native word text, confidence, layout identifiers, and frame-relative pixel boxes.
Confidence retains Tesseract's 0–100 scale.
Empty layout rows do not become words.
Invalid geometry, multiple pages, malformed rows, and invalid confidence cause rejection.
OCR does not classify a slide subtype or approve video eligibility.
Sampled instants do not establish continuous slide boundaries.

The evidence records source identity, model identity, runtime identity, representative evidence, and selection evidence.
Local file paths do not enter the result.
Measured wall times remain separate from the deterministic evidence checksum.
CPU time remains unknown in this adapter.
The separate fixture experiment measures native process CPU and memory.

The generated 854×480 fixture passed the real adapter with Tesseract 5.3.3 and verified English weights.
The adapter reproduced all five fixture words and returned their pixel boxes and native confidence.
The [retained report](../evaluation/p4-sparse-ocr-fixture-2026-10-16.json) contains the native result and model evidence.
Repeat the experiment with a new output directory:

```bash
python3 scripts/evaluate-ocr-fixture.py OUTPUTS/P4_SPARSE_OCR_NEW --sparse
```

The adapter has no production caller yet.
Automatic static-text selection, production coordinator configuration, and downstream slide classification remain unfinished.
The synthetic result does not establish representative slide recall or production resource budgets.

All 27 focused tests passed.
Lint, type checking, the worker build, and whitespace checks passed.

## Registered batch results

The internal source batch accepts an explicit OCR request and selection callback.
It runs OCR on extracted representatives while the existing source lease remains active.
OCR does not download the original again.
The callback receives local evidence and exact representative identities.
The adapter checks returned selections before inference.
The callback remains responsible for static-text selection evidence.

The batch registers a bounded JSON document as `LOCAL_EVIDENCE` with `ANALYSIS` retention.
The document links the local evidence artifact and selected frame artifacts.
It retains OCR words, model identity, runtime identity, and selection evidence.
It excludes local paths and measured wall times from immutable bytes.
Publication verifies stored bytes before marking the artifact `READY`.
Repeated execution reuses the same artifact when all evidence remains identical.
Repeated execution still runs local computation before publication reuse.
The existing cleanup service removes expired OCR objects and retains deletion evidence.

The measurement service records OCR wall time under `analysis_classification`.
Child CPU time and computation prices remain unknown.
The preparation coordinator accepts an optional internal OCR request.
The controlled PROBE entry does not yet supply an OCR request.

All 29 selected unit tests and five database cases passed for this integration.
Database cases used generated media and a simulated OCR executable.
They covered artifact reuse, selection failures, document limits, retention cleanup, and the existing derivative batch.
Lint, type checking, and the worker build passed.
