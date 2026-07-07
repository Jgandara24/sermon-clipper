import { readFileSync, writeFileSync } from "node:fs";
import {
  isLaunchEvidenceItemKey,
  launchEvidenceItems,
  recordLaunchEvidenceItem,
  validateLaunchEvidence,
  type LaunchEvidence,
  type LaunchEvidenceItem,
} from "../src/lib/deployment/launch-evidence";

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const filePath = argValue("--file") ?? process.env.LAUNCH_EVIDENCE_FILE ?? "docs/phase8-launch-evidence.json";
const itemKey = argValue("--item");
const proof = argValue("--evidence");
const status = (argValue("--status") ?? "passed") as LaunchEvidenceItem["status"];

if (process.argv.includes("--list")) {
  for (const item of launchEvidenceItems) {
    console.log(`${item.key}: ${item.label} - ${item.proof}`);
  }
  process.exit(0);
}

if (!itemKey) {
  console.error(`Missing item. Use --item <key>. Valid keys: ${launchEvidenceItems.map((item) => item.key).join(", ")}`);
  process.exit(2);
}

if (!isLaunchEvidenceItemKey(itemKey)) {
  console.error(`Unknown item '${itemKey}'. Valid keys: ${launchEvidenceItems.map((item) => item.key).join(", ")}`);
  process.exit(2);
}

if (!["passed", "failed", "not_applicable"].includes(status)) {
  console.error("Invalid status. Use passed, failed, or not_applicable.");
  process.exit(2);
}

if (!proof?.trim()) {
  console.error("Missing evidence. Use --evidence \"proof text\".");
  process.exit(2);
}

const evidence = JSON.parse(readFileSync(filePath, "utf8")) as LaunchEvidence;
const updated = recordLaunchEvidenceItem({
  evidence,
  itemKey,
  proof,
  status,
  verifiedAt: new Date().toISOString(),
});
writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`);

const validation = validateLaunchEvidence(updated, { expectedCommitSha: updated.commitSha });
for (const check of validation.checks) {
  const label = check.status.toUpperCase().padEnd(5);
  console.log(`${label} ${check.name}: ${check.message}`);
}

console.log(`\nUpdated ${filePath}`);
console.log(`Launch evidence status: ${validation.status}`);

if (status === "passed" && validation.checks.some((check) => check.name === itemKey && check.status === "fail")) {
  process.exit(1);
}
