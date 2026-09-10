#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { writeLocalAudioTimingBenchmark } from "../src/lib/evaluation/local-audio-timing-benchmark";

const USAGE = `Usage: npm run benchmark:local-audio-timing -- --output <new-json-file>
Generate a four-second tone-burst fixture and inspect one audio event in local AAC/FLAC files.
No input media, URL, database, provider, app, or worker is used. Generated files are removed.
The report must not exist. Failure or an unavailable observation exits nonzero.
Full source mapping, audio quality, caption accuracy, and audiovisual sync remain unverified.`;

async function main() {
  const { values } = parseArgs({ options: { output: { type: "string" }, help: { type: "boolean", short: "h" } },
    strict: true, allowPositionals: false });
  if (values.help) { console.log(USAGE); return; }
  if (!values.output) throw new Error(USAGE);
  const report = await writeLocalAudioTimingBenchmark(values.output);
  console.log(`Audio fixture ${report.outcome}. Report: ${values.output}. Full mapping and human quality remain unverified.`);
  if (report.outcome !== "succeeded") process.exitCode = 1;
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Local audio fixture failed."); process.exitCode = 1;
});
