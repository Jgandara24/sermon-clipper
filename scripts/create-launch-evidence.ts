import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createLaunchEvidenceTemplate } from "../src/lib/deployment/launch-evidence";

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function currentCommitSha() {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
}

const deploymentUrl = argValue("--base-url") ?? process.env.LAUNCH_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
const verifiedBy = argValue("--verified-by") ?? process.env.LAUNCH_VERIFIED_BY ?? "";
const outputPath = argValue("--output") ?? "docs/phase8-launch-evidence.json";
const force = process.argv.includes("--force");

if (!deploymentUrl) {
  console.error("Missing deployment URL. Use --base-url https://clips.example.org.");
  process.exit(2);
}

if (!verifiedBy) {
  console.error("Missing verifier name. Use --verified-by \"Name or team\".");
  process.exit(2);
}

if (existsSync(outputPath) && !force) {
  console.error(`${outputPath} already exists. Use --force to overwrite it.`);
  process.exit(2);
}

const template = createLaunchEvidenceTemplate({
  deploymentUrl,
  commitSha: currentCommitSha(),
  verifiedAt: new Date().toISOString(),
  verifiedBy,
});

writeFileSync(outputPath, `${JSON.stringify(template, null, 2)}\n`);
console.log(`Created ${outputPath}`);
console.log("Fill every TODO with production evidence and change each status to passed before verification.");
