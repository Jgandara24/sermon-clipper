import { readFileSync, writeFileSync } from "node:fs";
import type { LaunchEvidence } from "../src/lib/deployment/launch-evidence";
import { applyAutomatedLaunchEvidence } from "../src/lib/deployment/launch-evidence-collection";
import { runProductionSmoke } from "../src/lib/deployment/production-smoke";

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const filePath = argValue("--file") ?? process.env.LAUNCH_EVIDENCE_FILE ?? "docs/phase8-launch-evidence.json";
const baseUrl = argValue("--base-url") ?? process.env.SMOKE_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL;
const timeoutMs = Number(argValue("--timeout-ms") ?? process.env.SMOKE_TIMEOUT_MS ?? 15_000);
const expectedCommitShaOverride = argValue("--commit-sha") ?? process.env.SMOKE_COMMIT_SHA;
const expectProduction = !process.argv.includes("--allow-dev-login");

if (!baseUrl) {
  console.error("Missing base URL. Use --base-url https://clips.example.org or SMOKE_BASE_URL.");
  process.exit(2);
}

const resolvedBaseUrl = baseUrl;

async function main() {
  const evidence = JSON.parse(readFileSync(filePath, "utf8")) as LaunchEvidence;
  const expectedCommitSha = expectedCommitShaOverride ?? evidence.commitSha;
  const normalizedBaseUrl = resolvedBaseUrl.replace(/\/$/, "");
  const healthResponse = await fetch(`${normalizedBaseUrl}/api/health`, { cache: "no-store" });
  const healthPayload = await healthResponse.json().catch(() => null);
  const smoke = await runProductionSmoke({
    baseUrl: normalizedBaseUrl,
    timeoutMs,
    expectProduction,
    expectedCommitSha,
  });

  const updated = applyAutomatedLaunchEvidence({
    evidence,
    health: {
      baseUrl: normalizedBaseUrl,
      httpStatus: healthResponse.status,
      ok: healthResponse.ok,
      payload: healthPayload,
    },
    smoke,
    collectedAt: new Date().toISOString(),
  });

  writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`);

  for (const check of smoke.checks) {
    const label = check.status.toUpperCase().padEnd(7);
    console.log(`${label} ${check.name}: ${check.message}`);
  }
  console.log(`\nUpdated ${filePath}`);
  console.log(`Production smoke status: ${smoke.status}`);

  if (smoke.status === "fail" || !healthResponse.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
