#!/usr/bin/env tsx
/**
 * Validates labeled benchmark manifests, and regenerates the published JSON Schema.
 *
 * Usage:
 *   npm run verify:benchmark                       validate every manifest under evaluation/
 *   npm run verify:benchmark -- path/to/one.json   validate specific files
 *   npm run verify:benchmark -- --write-schema     regenerate evaluation/benchmark-manifest.schema.json
 *
 * Manifests never contain church media. They reference it by opaque artifactId and sha256, and the
 * validator fails any manifest that embeds a path or URL.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildJsonSchema, validateBenchmarkManifest } from "../src/lib/evaluation/benchmark-manifest";

const EVALUATION_DIR = resolve(__dirname, "..", "evaluation");
const SCHEMA_PATH = join(EVALUATION_DIR, "benchmark-manifest.schema.json");

function serializeSchema(): string {
  return `${JSON.stringify(buildJsonSchema(), null, 2)}\n`;
}

function writeSchema(): void {
  writeFileSync(SCHEMA_PATH, serializeSchema());
  console.log(`wrote ${SCHEMA_PATH}`);
}

function discoverManifests(): string[] {
  return readdirSync(EVALUATION_DIR)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".schema.json"))
    .map((name) => join(EVALUATION_DIR, name))
    .sort();
}

function validateFile(path: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`FAIL ${path}\n  not valid JSON: ${(error as Error).message}`);
    return false;
  }

  const result = validateBenchmarkManifest(raw);
  if (!result.ok) {
    console.error(`FAIL ${path}`);
    for (const issue of result.issues) console.error(`  ${issue.path}: ${issue.message}`);
    return false;
  }

  for (const warning of result.warnings) console.warn(`  warn ${warning.path}: ${warning.message}`);
  const { candidates, source } = result.manifest;
  console.log(`ok   ${path}  (${candidates.length} candidates, source ${source.artifactId})`);
  return true;
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--write-schema")) {
    writeSchema();
    return;
  }

  // The committed schema is generated, so a stale copy is a failure rather than a nuisance.
  const committed = (() => {
    try {
      return readFileSync(SCHEMA_PATH, "utf8");
    } catch {
      return null;
    }
  })();
  if (committed !== serializeSchema()) {
    console.error(`FAIL ${SCHEMA_PATH} is stale or missing. Run: npm run verify:benchmark -- --write-schema`);
    process.exit(1);
  }

  const targets = args.length > 0 ? args.map((a) => resolve(a)) : discoverManifests();
  if (targets.length === 0) {
    console.log("no manifests found under evaluation/ — nothing to validate");
    return;
  }

  const failures = targets.filter((path) => !validateFile(path)).length;
  if (failures > 0) {
    console.error(`\n${failures} of ${targets.length} manifest(s) failed`);
    process.exit(1);
  }
  console.log(`\n${targets.length} manifest(s) valid`);
}

main();
