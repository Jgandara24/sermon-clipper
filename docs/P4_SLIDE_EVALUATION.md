# Slide detection evaluation

P4 requires published full-screen-slide recall for each detector version.
`evaluateSlides` measures that recall within intervals that a human reviewed.
It uses labeled milliseconds, rather than frame counts or average service percentages.
It does not verify the reviewer, label quality, dataset representativeness, or detector license.

Run the evaluation with:

```bash
npx tsx scripts/evaluate-slides.ts INPUT.json OUTPUT.json
```

The command validates the input and writes a JSON report.
It refuses to overwrite an existing report.
It makes no database, model, storage-provider, or publication request.

The input contains these fields:

- `datasetId`: the dataset reference.
- `sources`: source UUIDs, checksums, review references, reviewed intervals, and labeled slide intervals.
- `runs`: detector versions, configuration checksums, completed source identities, and `MediaRegionFact` records.

Each source uses `sourceVideoId` and `sourceSha256`.
Each reviewed interval uses `startMs` and `endMs` in source time.
Each label contains `sourceInterval` and `subtype`.
Subtypes use the existing `slideSubtypeSchema` values.
Each run must list every source exactly once in `completedSources`.
A completed run with no detection facts still counts as a completed measurement.
Missing run sources cause rejection instead of zero-filled results.

Labels must lie completely within reviewed intervals.
Labels cannot overlap.
Predictions can overlap, but the report counts their union once.
The report scores predictions only within reviewed intervals.
It does not treat unreviewed time as negative evidence.
Detector and source identities must match the run and dataset.

The report includes overall, per-source, and per-subtype measurements.
Each measurement includes labeled, predicted, matched, missed, and false-positive milliseconds.
Recall divides matched time by labeled time.
Precision divides matched time by predicted time.
An empty denominator produces `null`.
A completed run with positive labels and no predictions produces zero recall.

The report compares overall recall with the plan's 0.9 target.
Passing this comparison does not approve production use.
`productionApproval` remains `not_evaluated`.
The report includes the input checksum and all review references.
Subtype errors remain visible even when overall slide detection succeeds.

Fourteen unit tests passed using synthetic intervals.
The command test verified report creation, missed-slide measurement, and overwrite refusal.
Lint and application type checking passed.
These tests do not establish detector recall on real services.
A representative labeled dataset and completed detector runs remain necessary for P4 acceptance.
