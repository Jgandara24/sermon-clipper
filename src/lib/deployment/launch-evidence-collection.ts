import type { LaunchEvidence, LaunchEvidenceItem } from "@/lib/deployment/launch-evidence";
import type { SmokeResult } from "@/lib/deployment/production-smoke";

export type HealthEvidencePayload = {
  baseUrl: string;
  httpStatus: number;
  ok: boolean;
  payload: {
    status?: string;
    deployment?: { commitSha?: string | null; commitSource?: string | null };
    checks?: Array<{ name?: string; status?: string; message?: string }>;
  } | null;
};

export type AutomatedLaunchEvidenceInput = {
  evidence: LaunchEvidence;
  health: HealthEvidencePayload;
  smoke: SmokeResult;
  collectedAt: string;
};

function formatHealthEvidence(health: HealthEvidencePayload) {
  const deployment = health.payload?.deployment;
  const checks = health.payload?.checks ?? [];
  const failedChecks = checks.filter((check) => check.status === "fail");
  const checkSummary = checks
    .map((check) => `${check.name ?? "unknown"}=${check.status ?? "unknown"}`)
    .join(", ");

  return [
    `Collected ${health.baseUrl}/api/health at HTTP ${health.httpStatus}.`,
    `Readiness status: ${health.payload?.status ?? "missing"}.`,
    `Deployment commit: ${deployment?.commitSha ?? "missing"} (${deployment?.commitSource ?? "unknown source"}).`,
    `Failed readiness checks: ${failedChecks.length}.`,
    checkSummary ? `Checks: ${checkSummary}.` : "Checks: none reported.",
  ].join(" ");
}

function formatSmokeEvidence(smoke: SmokeResult) {
  const checkSummary = smoke.checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.message}`);
  return [`Production smoke status: ${smoke.status}.`, ...checkSummary].join("\n");
}

function automatedItem(status: LaunchEvidenceItem["status"], evidence: string): LaunchEvidenceItem {
  return { status, evidence };
}

function healthPassed(health: HealthEvidencePayload) {
  return (
    health.ok &&
    !!health.payload?.status &&
    health.payload.status !== "fail" &&
    Array.isArray(health.payload.checks) &&
    !health.payload.checks.some((check) => check.status === "fail")
  );
}

export function applyAutomatedLaunchEvidence(input: AutomatedLaunchEvidenceInput): LaunchEvidence {
  return {
    ...input.evidence,
    verifiedAt: input.collectedAt,
    items: {
      ...input.evidence.items,
      healthCheck: automatedItem(healthPassed(input.health) ? "passed" : "failed", formatHealthEvidence(input.health)),
      productionSmoke: automatedItem(
        input.smoke.status === "fail" ? "failed" : "passed",
        formatSmokeEvidence(input.smoke),
      ),
    },
  };
}
