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

export type LaunchEvidenceValidationOptions = {
  expectedCommitSha?: string;
  expectedDeploymentUrl?: string;
};

export const launchEvidenceItems = [
  {
    key: "healthCheck",
    label: "Health check",
    proof: "Paste curl -fsS <deploymentUrl>/api/health output showing no failed readiness checks.",
  },
  {
    key: "productionSmoke",
    label: "Production smoke",
    proof: "Paste npm run smoke:production -- --base-url <deploymentUrl> output.",
  },
  {
    key: "webProcess",
    label: "Web process",
    proof: "Deployment platform shows the web process running this commit.",
  },
  {
    key: "workerProcess",
    label: "Worker process",
    proof: "Deployment platform shows at least one worker process running with stable WORKER_ID.",
  },
  {
    key: "databaseMigrations",
    label: "Database migrations",
    proof: "npm run db:migrate:deploy completed successfully against production.",
  },
  { key: "authEmail", label: "Auth email", proof: "A real user received and verified an email OTP through SendGrid." },
  { key: "workspaceCreate", label: "Workspace create", proof: "A real user created a workspace in production." },
  {
    key: "workspaceJoin",
    label: "Workspace join",
    proof: "A second real user accepted an invitation through /join/:token.",
  },
  { key: "upload", label: "Upload", proof: "A sermon video uploaded to the configured production S3/R2 bucket." },
  {
    key: "processing",
    label: "Processing",
    proof: "FINALIZE, PROBE, TRANSCRIBE, and ANALYZE completed or failed recoverably with visible events.",
  },
  {
    key: "clipRanking",
    label: "Clip ranking",
    proof: "Ranked church-aware clips appeared with scripture/church scoring where applicable.",
  },
  { key: "branding", label: "Branding", proof: "A brand template was applied in the editor." },
  {
    key: "approvalNotification",
    label: "Approval notification",
    proof: "A real approval email and/or SMS was delivered.",
  },
  { key: "reviewApproval", label: "Review approval", proof: "The secure /review/:token link was viewed and approved." },
  { key: "export", label: "Export", proof: "An approved clip exported through the worker." },
  {
    key: "download",
    label: "Download",
    proof: "The MP4 downloaded through a short-lived signed URL from production storage.",
  },
  {
    key: "billing",
    label: "Billing",
    proof: "Stripe Checkout/Portal and webhook handling updated the workspace plan and granted minutes.",
  },
  {
    key: "usageLimits",
    label: "Usage limits",
    proof: "Insufficient minutes or plan limit conditions were blocked without negative balances.",
  },
  {
    key: "observability",
    label: "Observability",
    proof: "/app/settings/operations showed upload, processing, approval, export, billing, and worker events.",
  },
  { key: "ci", label: "CI", proof: "verify, integration, and e2e CI jobs passed for this commit." },
] as const;

export type LaunchEvidenceTemplateOptions = {
  deploymentUrl: string;
  commitSha: string;
  verifiedAt: string;
  verifiedBy: string;
};

export type LaunchEvidenceItemKey = (typeof launchEvidenceItems)[number]["key"];

const launchEvidenceItemKeys = new Set<string>(launchEvidenceItems.map((item) => item.key));
const minimumEvidenceLength = 20;

export function isLaunchEvidenceItemKey(key: string): key is LaunchEvidenceItemKey {
  return launchEvidenceItemKeys.has(key);
}

export type RecordLaunchEvidenceItemOptions = {
  evidence: LaunchEvidence;
  itemKey: string;
  proof: string;
  status?: LaunchEvidenceItem["status"];
  verifiedAt: string;
};

export function createLaunchEvidenceTemplate(options: LaunchEvidenceTemplateOptions): LaunchEvidence {
  return {
    deploymentUrl: options.deploymentUrl,
    commitSha: options.commitSha,
    verifiedAt: options.verifiedAt,
    verifiedBy: options.verifiedBy,
    items: Object.fromEntries(
      launchEvidenceItems.map((item) => [
        item.key,
        {
          status: "failed",
          evidence: `TODO: ${item.proof.replaceAll("<deploymentUrl>", options.deploymentUrl)}`,
        },
      ]),
    ),
  };
}

export function recordLaunchEvidenceItem(options: RecordLaunchEvidenceItemOptions): LaunchEvidence {
  if (!isLaunchEvidenceItemKey(options.itemKey)) {
    throw new Error(`Unknown launch evidence item: ${options.itemKey}`);
  }
  return {
    ...options.evidence,
    verifiedAt: options.verifiedAt,
    items: {
      ...options.evidence.items,
      [options.itemKey]: {
        status: options.status ?? "passed",
        evidence: options.proof,
      },
    },
  };
}

function checkString(name: string, value: unknown): LaunchEvidenceCheck {
  return typeof value === "string" && value.trim()
    ? { name, status: "ok", message: `${name} is present.` }
    : { name, status: "fail", message: `${name} is required.` };
}

function checkIsoTimestamp(name: string, value: unknown): LaunchEvidenceCheck {
  if (typeof value !== "string" || !value.trim()) {
    return { name, status: "fail", message: `${name} is required.` };
  }
  if (Number.isNaN(Date.parse(value))) {
    return { name, status: "fail", message: `${name} must be a parseable timestamp.` };
  }
  return { name, status: "ok", message: `${name} is a valid timestamp.` };
}

function checkUnknownEvidenceItems(items: LaunchEvidence["items"]): LaunchEvidenceCheck {
  const knownKeys = new Set<string>(launchEvidenceItems.map((item) => item.key));
  const unknownKeys = Object.keys(items ?? {}).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) {
    return {
      name: "items",
      status: "fail",
      message: `Unknown launch evidence item(s): ${unknownKeys.join(", ")}.`,
    };
  }
  return { name: "items", status: "ok", message: "Launch evidence item keys are recognized." };
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

function normalizedDeploymentUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function checkExpectedDeploymentUrl(value: unknown, expectedDeploymentUrl: string): LaunchEvidenceCheck {
  if (typeof value !== "string") {
    return {
      name: "deploymentUrlMatches",
      status: "fail",
      message: "deploymentUrl is required before it can be matched.",
    };
  }

  try {
    const actual = normalizedDeploymentUrl(value);
    const expected = normalizedDeploymentUrl(expectedDeploymentUrl);
    if (actual !== expected) {
      return {
        name: "deploymentUrlMatches",
        status: "fail",
        message: `Evidence deployment URL ${value} does not match expected deployment URL ${expectedDeploymentUrl}.`,
      };
    }
    return { name: "deploymentUrlMatches", status: "ok", message: "Evidence deployment URL matches expected URL." };
  } catch {
    return {
      name: "deploymentUrlMatches",
      status: "fail",
      message: "deploymentUrl and expected deployment URL must be valid URLs before they can be matched.",
    };
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

function checkExpectedCommitSha(value: unknown, expectedCommitSha: string): LaunchEvidenceCheck {
  if (typeof value !== "string") {
    return { name: "commitShaMatches", status: "fail", message: "commitSha is required before it can be matched." };
  }

  const actual = value.trim().toLowerCase();
  const expected = expectedCommitSha.trim().toLowerCase();
  if (!actual || !expected || !(actual.startsWith(expected) || expected.startsWith(actual))) {
    return {
      name: "commitShaMatches",
      status: "fail",
      message: `Evidence commit ${value} does not match expected commit ${expectedCommitSha}.`,
    };
  }

  return { name: "commitShaMatches", status: "ok", message: "Evidence commit matches expected commit." };
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
  if (item.evidence.trim().length < minimumEvidenceLength) {
    return {
      name: key,
      status: "fail",
      message: `${label} proof is too short to be useful launch evidence.`,
    };
  }
  if (/^\s*(todo|paste|placeholder|example)\b/i.test(item.evidence)) {
    return { name: key, status: "fail", message: `${label} proof still looks like placeholder text.` };
  }
  return { name: key, status: "ok", message: `${label} has passing evidence.` };
}

export function validateLaunchEvidence(
  input: unknown,
  options: LaunchEvidenceValidationOptions = {},
): LaunchEvidenceResult {
  if (!input || typeof input !== "object") {
    return {
      status: "fail",
      checks: [{ name: "file", status: "fail", message: "Launch evidence must be a JSON object." }],
    };
  }

  const evidence = input as LaunchEvidence;
  const checks: LaunchEvidenceCheck[] = [
    checkDeploymentUrl(evidence.deploymentUrl),
    ...(options.expectedDeploymentUrl
      ? [checkExpectedDeploymentUrl(evidence.deploymentUrl, options.expectedDeploymentUrl)]
      : []),
    checkCommitSha(evidence.commitSha),
    ...(options.expectedCommitSha ? [checkExpectedCommitSha(evidence.commitSha, options.expectedCommitSha)] : []),
    checkIsoTimestamp("verifiedAt", evidence.verifiedAt),
    checkString("verifiedBy", evidence.verifiedBy),
    checkUnknownEvidenceItems(evidence.items),
    ...launchEvidenceItems.map((item) => checkEvidenceItem(evidence, item.key, item.label)),
  ];

  return {
    status: checks.some((check) => check.status === "fail") ? "fail" : "ok",
    checks,
  };
}
