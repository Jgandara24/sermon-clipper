export type LaunchEvidenceItem = {
  status: "passed" | "failed" | "not_applicable";
  evidence: string;
};

export type LaunchEvidence = {
  deploymentUrl: string;
  commitSha: string;
  verifiedAt: string;
  verifiedBy: string;
  items: Record<string, LaunchEvidenceItem | undefined>;
};

export type LaunchEvidenceCheck = {
  name: string;
  status: "ok" | "fail";
  message: string;
};

export type LaunchEvidenceResult = {
  status: "ok" | "fail";
  checks: LaunchEvidenceCheck[];
};

export const launchEvidenceItems = [
  { key: "healthCheck", label: "Health check" },
  { key: "productionSmoke", label: "Production smoke" },
  { key: "webProcess", label: "Web process" },
  { key: "workerProcess", label: "Worker process" },
  { key: "databaseMigrations", label: "Database migrations" },
  { key: "authEmail", label: "Auth email" },
  { key: "workspaceCreate", label: "Workspace create" },
  { key: "workspaceJoin", label: "Workspace join" },
  { key: "upload", label: "Upload" },
  { key: "processing", label: "Processing" },
  { key: "clipRanking", label: "Clip ranking" },
  { key: "branding", label: "Branding" },
  { key: "approvalNotification", label: "Approval notification" },
  { key: "reviewApproval", label: "Review approval" },
  { key: "export", label: "Export" },
  { key: "download", label: "Download" },
  { key: "billing", label: "Billing" },
  { key: "usageLimits", label: "Usage limits" },
  { key: "observability", label: "Observability" },
  { key: "ci", label: "CI" },
] as const;

function checkString(name: string, value: unknown): LaunchEvidenceCheck {
  return typeof value === "string" && value.trim()
    ? { name, status: "ok", message: `${name} is present.` }
    : { name, status: "fail", message: `${name} is required.` };
}

function checkDeploymentUrl(value: unknown): LaunchEvidenceCheck {
  if (typeof value !== "string" || !value.trim()) {
    return { name: "deploymentUrl", status: "fail", message: "deploymentUrl is required." };
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return { name: "deploymentUrl", status: "fail", message: "deploymentUrl must use HTTPS." };
    }
    return { name: "deploymentUrl", status: "ok", message: "deploymentUrl is HTTPS." };
  } catch {
    return { name: "deploymentUrl", status: "fail", message: "deploymentUrl must be a valid URL." };
  }
}

function checkCommitSha(value: unknown): LaunchEvidenceCheck {
  if (typeof value !== "string" || !/^[0-9a-f]{7,40}$/i.test(value.trim())) {
    return {
      name: "commitSha",
      status: "fail",
      message: "commitSha must be a 7-40 character git SHA.",
    };
  }
  return { name: "commitSha", status: "ok", message: "commitSha looks valid." };
}

function checkEvidenceItem(evidence: LaunchEvidence, key: string, label: string): LaunchEvidenceCheck {
  const item = evidence.items?.[key];
  if (!item) {
    return { name: key, status: "fail", message: `${label} evidence is missing.` };
  }
  if (item.status !== "passed") {
    return {
      name: key,
      status: "fail",
      message: `${label} must be marked passed before Phase 8 is complete.`,
    };
  }
  if (!item.evidence?.trim()) {
    return { name: key, status: "fail", message: `${label} needs non-empty proof.` };
  }
  return { name: key, status: "ok", message: `${label} has passing evidence.` };
}

export function validateLaunchEvidence(input: unknown): LaunchEvidenceResult {
  if (!input || typeof input !== "object") {
    return {
      status: "fail",
      checks: [{ name: "file", status: "fail", message: "Launch evidence must be a JSON object." }],
    };
  }

  const evidence = input as LaunchEvidence;
  const checks: LaunchEvidenceCheck[] = [
    checkDeploymentUrl(evidence.deploymentUrl),
    checkCommitSha(evidence.commitSha),
    checkString("verifiedAt", evidence.verifiedAt),
    checkString("verifiedBy", evidence.verifiedBy),
    ...launchEvidenceItems.map((item) => checkEvidenceItem(evidence, item.key, item.label)),
  ];

  return {
    status: checks.some((check) => check.status === "fail") ? "fail" : "ok",
    checks,
  };
}
