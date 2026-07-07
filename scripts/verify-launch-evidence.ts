import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { validateLaunchEvidence } from "../src/lib/deployment/launch-evidence";

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const filePath = argValue("--file") ?? process.env.LAUNCH_EVIDENCE_FILE;
const expectedCommitSha =
  argValue("--commit-sha") ??
  process.env.LAUNCH_COMMIT_SHA ??
  (process.argv.includes("--skip-commit-check")
    ? undefined
    : execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim());

if (!filePath) {
  console.error("Missing evidence file. Use --file docs/phase8-launch-evidence.json.");
  process.exit(2);
}

let payload: unknown;
try {
  payload = JSON.parse(readFileSync(filePath, "utf8"));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const result = validateLaunchEvidence(payload, { expectedCommitSha });

for (const check of result.checks) {
  const label = check.status.toUpperCase().padEnd(5);
  console.log(`${label} ${check.name}: ${check.message}`);
}

console.log(`\nLaunch evidence status: ${result.status}`);

if (result.status === "fail") {
  process.exit(1);
}
