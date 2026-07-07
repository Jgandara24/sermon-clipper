import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { validateLaunchEvidence } from "../src/lib/deployment/launch-evidence";

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const filePath = argValue("--file") ?? process.env.LAUNCH_EVIDENCE_FILE;
const expectedDeploymentUrl = argValue("--base-url") ?? process.env.LAUNCH_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
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

if (!existsSync(filePath)) {
  console.error(`${filePath} does not exist.`);
  console.error('Create it first with: npm run create:launch-evidence -- --base-url https://clips.example.org --verified-by "Launch operator"');
  process.exit(2);
}

let payload: unknown;
try {
  payload = JSON.parse(readFileSync(filePath, "utf8"));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const result = validateLaunchEvidence(payload, { expectedCommitSha, expectedDeploymentUrl });

for (const check of result.checks) {
  const label = check.status.toUpperCase().padEnd(5);
  console.log(`${label} ${check.name}: ${check.message}`);
}

console.log(`\nLaunch evidence status: ${result.status}`);

if (result.status === "fail") {
  process.exit(1);
}
