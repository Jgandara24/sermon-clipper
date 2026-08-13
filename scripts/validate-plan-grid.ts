#!/usr/bin/env tsx
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildPlanGridReport } from "../src/lib/billing/plan-grid";

const ROOT = resolve(__dirname, "..");

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(name) ? [path] : [];
  });
}

function requireFact(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Plan-grid source audit failed: ${message}`);
}

function auditSourceFacts(): void {
  const plans = source("src/lib/billing/plans.ts");
  const ledger = source("src/lib/usage-ledger.ts");
  const presign = source("src/app/api/uploads/presign/route.ts");
  const finalize = source("src/lib/jobs/handlers/finalize.ts");
  const allowedOverageFiles = new Set([
    "src/lib/billing/plans.ts",
    "src/lib/billing/plan-grid.ts",
  ]);
  const runtimeOverageReads = sourceFiles(join(ROOT, "src"))
    .map((path) => ({ path: relative(ROOT, path), contents: readFileSync(path, "utf8") }))
    .filter(({ path, contents }) => !allowedOverageFiles.has(path) && contents.includes("overageAllowed"));

  requireFact(runtimeOverageReads.length === 0, "overageAllowed gained a runtime reader");
  requireFact(
    plans.includes('stripePriceEnvVar: "STRIPE_PRICE_STARTER"') &&
      plans.includes('stripePriceEnvVar: "STRIPE_PRICE_PRO"'),
    "paid plan prices no longer resolve through the two Stripe environment keys",
  );
  requireFact(!plans.includes("priceUsd"), "a dollar price was added to the plan-limit table");
  requireFact(
    ledger.includes("SET minute_balance = minute_balance + ${amount}"),
    "billing-period grants no longer add to the existing minute balance",
  );
  requireFact(
    presign.includes("workspace.minuteBalance.lessThanOrEqualTo(0)") &&
      !presign.includes("estimateProcessingMinutes"),
    "upload presign no longer uses the documented positive-balance-only gate",
  );
  requireFact(
    finalize.includes("estimateProcessingMinutes(probeResult.durationS)") &&
      finalize.includes("reserveMinutesForJob"),
    "FINALIZE no longer owns the duration-based reservation",
  );
  requireFact(
    ledger.includes("AND minute_balance + ${params.minutesDelta} >= 0") &&
      ledger.includes("throw new InsufficientBalanceError"),
    "minute reservations no longer hard-block before a negative balance",
  );
}

function main(): void {
  auditSourceFacts();
  const report = buildPlanGridReport();
  console.log(JSON.stringify({ schemaVersion: 1, sourceAuditPassed: true, ...report }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
