# P0 Gate A Cost-Truth Runbook

Use this runbook to prove the cost of one real service. The output contains counts, times, provider
names, host names, and costs. It contains no media, transcript, source URL, project name, workspace
name, or credential.

## Current hard-stop result

`evaluation/proxy-cost-baseline-2026-08-13.json` records the current production lower bound. The
real IPRoyal order was 2 GB for $12.50, or $6.25/GB. The recorded 49:41 production source is
392,808,104 stored bytes. Its source-byte proxy cost is $2.4551 per service and $21.26 per typical
church month before core processing. Adding only the measured analysis anchor produces a $22.62
monthly lower bound. The $12 YouTube gate fails.

Do not run a second paid YouTube service only to reproduce this failure. Use one real direct upload
for Gate A. Keep YouTube disapproved until its contract or intake path can pass its separate gate.

## Preconditions

1. Deploy P0.11 through P0.19 and both P0.17 migrations.
2. Keep automatic publishing disabled.
3. Set these worker variables from current contracts. Do not use a public estimate.

   - `YTDLP_PROXY_PRICE_PER_GB_USD`
   - `RAILWAY_EGRESS_PRICE_PER_GB_USD`
   - `STORAGE_DOWNLOAD_PRICE_PER_GB_USD`
   - `STORAGE_UPLOAD_PRICE_PER_GB_USD`

4. Confirm that `STORAGE_S3_ENDPOINT` is the production endpoint. Record only its host name.
5. For a YouTube run, confirm the proxy price against the provider order or invoice. Protocol
   overhead can make the provider invoice higher than the stored file size. Compare the report
   with the provider usage after the run.

A missing price creates an `unpriced` cost fact. It blocks Gate A. Zero is valid only when the
contract has a zero price for that unit. Cloudflare R2 direct egress has a zero price, but the
configured value is still required so the report proves that this was checked.

## Run one real service

1. Upload one real service through the production browser upload flow. Create its project.
2. Let `FINALIZE`, `PROBE`, `TRANSCRIBE`, and `ANALYZE` finish.
3. Confirm that the source-acquisition fact uses `browser_direct`, says `proxyUsed: false`, and has
   the same measured byte count as the completed upload. Confirm separate Railway-egress and
   storage-upload facts.
4. Export at least one retained clip. Let the export finish.
5. Wait for the cost rollup, or run the project cost report once to rebuild its rollup rows:

   ```bash
   npm run report:project-cost -- --project-id <project-uuid>
   ```

The run must use the production provider selection. Do not use the heuristic analyzer. Do not use a
fixture, mock transport, free credit, or a copied estimate as measured evidence. The direct-upload
report uses the $8 typical monthly gate. A YouTube-proxy report uses the $12 gate and must also
prove the proxy host and contracted price.

## Create the public-safe evidence file

Run the generator with production worker configuration and the measured project ID:

```bash
npm run create:project-cost-report -- \
  --project-id <project-uuid> \
  --output evaluation/p0-cost-truth-YYYY-MM-DD.json
```

The generator reads immutable `processing_cost_fact` events. It measures the stored source,
derivatives, and export objects. It derives these totals from charge rows:

- proxy cost per source hour, which is zero for direct upload;
- intake cost per service;
- core cost per service;
- total cost per service;
- cost for a typical church month at 8.66 services;
- retry count;
- Gate A result.

The generator uses `wx` file creation. It does not overwrite an existing evidence file. It refuses
to write a file when a stage is missing, a unit is unpriced, a charge is duplicated, totals do not
reconcile, or a cost gate fails.

## Validate the stored report

```bash
npm run verify:project-cost -- evaluation/p0-cost-truth-YYYY-MM-DD.json
```

The validator requires these measured stages:

- source acquisition and Railway egress;
- storage download and upload facts;
- local audio extraction;
- transcription;
- analysis classification and scoring;
- final render.

Each analysis charge must include the actual provider, model, input tokens, output tokens, and image
count. A zero image count is an explicit measurement. It is not an omitted value.

The validator reconciles analysis input-token and output-token volume within 25 percent of the
committed `Clip Count Retest 8-11` anchor. Token volume is the stable usage check across model and
price changes. The report still records the exact paid cost and checks it against the core cost
cap. It also enforces:

- core technical cost of no more than $1.50 per service;
- projected typical direct-upload cost of no more than $8.00 per church month, or YouTube-proxy
  cost of no more than $12.00 per church month;
- no unpriced unit;
- production intake, relay, and storage evidence;
- the contracted relay and storage egress rates;
- production proxy host and contracted price evidence for a YouTube-proxy report;
- retry cost inclusion.

## Hard stop

Do not change measured totals to make the validator pass. Do not approve YouTube economics when the
real contracted proxy result exceeds the gate. A passing direct-upload report does not approve the
YouTube path. Change the YouTube intake path or contract before a new YouTube approval run.
