#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCostTruthReport } from "../src/lib/cost/report";

function reportPath(args: string[]): string {
  const path = args[0];
  if (!path) {
    throw new Error(
      "Usage: npm run verify:project-cost -- evaluation/<real-service-cost-report>.json",
    );
  }
  return resolve(path);
}

function main(): void {
  const path = reportPath(process.argv.slice(2));
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read a JSON cost report at ${path}: ${(error as Error).message}`);
  }

  const result = validateCostTruthReport(input);
  if (!result.ok) {
    console.error(`FAIL ${path}`);
    for (const issue of result.issues) console.error(`  ${issue}`);
    process.exitCode = 1;
    return;
  }

  const summary = result.summary;
  console.log(`PASS ${path}`);
  console.log(`  proxy cost/source hour: $${summary.proxyCostPerSourceHourUsd.toFixed(4)}`);
  console.log(`  core cost/service: $${summary.coreCostPerServiceUsd.toFixed(4)}`);
  console.log(`  total cost/service: $${summary.serviceCostUsd.toFixed(4)}`);
  console.log(
    `  projected typical church/month: $${summary.projectedMonthlyChurchCostUsd.toFixed(2)}`,
  );
  console.log(`  retries: ${summary.retryCount}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
