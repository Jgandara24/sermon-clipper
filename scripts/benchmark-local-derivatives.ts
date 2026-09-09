#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { writeLocalDerivativeBenchmark } from "../src/lib/evaluation/local-derivative-benchmark";

const USAGE = `Usage:
  npm run benchmark:local-derivatives -- --output <new-json-file> [--duration-seconds <2..10>] [--observe-marker]

Create a short synthetic source and three experimental derivatives on this computer.
Measure creation separately from inspection. Remove generated media after the run.
Optionally inspect the synthetic video marker. A mismatch or unavailable observation fails the requested check.
No input media, URL, database, provider, app, or worker is used. Quality remains unreviewed.
The report must not already exist. A failed benchmark writes its failure and exits nonzero.`;

async function main() {
  const { values } = parseArgs({ options: {
    output: { type: "string" }, "duration-seconds": { type: "string" }, help: { type: "boolean", short: "h" },
    "observe-marker": { type: "boolean" },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(USAGE); return; }
  if (!values.output) throw new Error(USAGE);
  const report = await writeLocalDerivativeBenchmark(values.output, {
    durationSeconds: values["duration-seconds"] === undefined ? 4 : Number(values["duration-seconds"]),
    observeMarker: values["observe-marker"] ?? false,
  });
  console.log(`Benchmark ${report.outcome}. Report: ${values.output}. Quality and content mapping remain unreviewed.`);
  if (report.outcome !== "succeeded") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Local benchmark failed.");
  process.exitCode = 1;
});
