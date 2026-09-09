#!/usr/bin/env tsx
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { localMediaMeasurementInput, measureLocalMedia } from "../src/lib/evaluation/local-media-measurement";

const USAGE = `Usage:
  npm run measure:local-media -- --source <local-video> --artifact <local-file>
    --artifact-id <opaque-id> --kind <proxy|range|audio>
    --source-start-ms <number> --source-end-ms <number> --output <new-json-file>

Reads local files. Does not create media, call providers, or connect to a database.
The source range is your declaration. The report does not prove content alignment
or human quality. The output file must not already exist.`;

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: "string" }, artifact: { type: "string" }, "artifact-id": { type: "string" },
    kind: { type: "string" }, "source-start-ms": { type: "string" }, "source-end-ms": { type: "string" },
    output: { type: "string" }, help: { type: "boolean", short: "h" },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(USAGE); return; }
  if (!values.output || !values["source-start-ms"]?.trim() || !values["source-end-ms"]?.trim()) {
    throw new Error(USAGE);
  }
  const input = localMediaMeasurementInput.parse({
    sourceFile: values.source, artifactFile: values.artifact, artifactId: values["artifact-id"],
    kind: values.kind, sourceStartMs: Number(values["source-start-ms"]), sourceEndMs: Number(values["source-end-ms"]),
  });
  const report = await measureLocalMedia(input);
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(`Wrote local measurements to ${values.output}. Content mapping and quality remain unreviewed.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Local media measurement failed.");
  process.exitCode = 1;
});
