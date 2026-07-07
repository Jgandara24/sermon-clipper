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
    proof:
      "Deployment platform shows at least one worker process running with stable WORKER_ID, ffmpeg/ffprobe, whisper-cli, and readable WHISPER_MODEL_PATH.",
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
    key: "transcriptionProvider",
    label: "Transcription provider",
    proof: "Production worker transcribed the sermon with whisper.cpp using the configured WHISPER_MODEL_PATH.",
  },
  {
    key: "analysisProvider",
    label: "AI analysis provider",
    proof: "Production worker scored clips with Claude using ANTHROPIC_API_KEY, not the heuristic fallback.",
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
const providerEvidenceChecks: Partial<Record<LaunchEvidenceItemKey, (proof: string) => string | null>> = {
  authEmail: (proof) => {
    const required = [
      { label: "email OTP", pattern: /\bemail\b.*\bOTP\b|\bOTP\b.*\bemail\b/i },
      { label: "SendGrid", pattern: /\bsendgrid\b/i },
      { label: "verified", pattern: /\bverified\b|\bverification\b|\bsign(?:ed)?\s+in\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Auth email proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  workspaceCreate: (proof) => {
    const required = [
      { label: "real user", pattern: /\breal\b.*\buser\b|\buser\b.*\breal\b/i },
      { label: "workspace", pattern: /\bworkspace\b/i },
      { label: "created", pattern: /\bcreated\b|\bcreate\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Workspace create proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  workspaceJoin: (proof) => {
    const required = [
      { label: "second user", pattern: /\bsecond\b.*\buser\b|\binvite[de]?\b.*\buser\b/i },
      { label: "/join/:token or invitation", pattern: /\/join\/:token|\/join\/|invitation/i },
      { label: "accepted", pattern: /\baccepted\b|\bjoined\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Workspace join proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  upload: (proof) => {
    const required = [
      { label: "sermon video", pattern: /\bsermon\b.*\bvideo\b|\bvideo\b.*\bsermon\b/i },
      { label: "S3/R2", pattern: /\b(?:S3|R2)\b/i },
      { label: "bucket", pattern: /\bbucket\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Upload proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  processing: (proof) => {
    const required = ["FINALIZE", "PROBE", "TRANSCRIBE", "ANALYZE"].map((stage) => ({
      label: stage,
      pattern: new RegExp(`\\b${stage}\\b`, "i"),
    }));
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Processing proof must mention completed/recoverable stage(s): ${missing.join(", ")}.`;
    }
    if (!/\bcompleted\b|\bsucceeded\b|\brecoverable\b/i.test(proof)) {
      return "Processing proof must mention completed, succeeded, or recoverable processing events.";
    }
    return null;
  },
  workerProcess: (proof) => {
    const required = [
      { label: "WORKER_ID", pattern: /\bWORKER_ID\b/ },
      { label: "ffmpeg", pattern: /\bffmpeg\b/i },
      { label: "ffprobe", pattern: /\bffprobe\b/i },
      { label: "whisper-cli or whisper.cpp", pattern: /\b(?:whisper-cli|whisper\.cpp|whisper_cpp)\b/i },
      { label: "WHISPER_MODEL_PATH", pattern: /\bWHISPER_MODEL_PATH\b/ },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Worker process proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  transcriptionProvider: (proof) => {
    if (!/\bwhisper(?:\.cpp|_cpp|-cpp)?\b/i.test(proof)) {
      return "Transcription provider proof must mention whisper.cpp or whisper_cpp.";
    }
    if (!/\bWHISPER_MODEL_PATH\b/.test(proof)) {
      return "Transcription provider proof must mention the configured WHISPER_MODEL_PATH.";
    }
    return null;
  },
  analysisProvider: (proof) => {
    if (!/\bclaude\b/i.test(proof)) {
      return "AI analysis provider proof must mention Claude.";
    }
    if (!/\bANTHROPIC_API_KEY\b/.test(proof)) {
      return "AI analysis provider proof must mention ANTHROPIC_API_KEY-backed scoring.";
    }
    if (/\bheuristic(?:-v1)?\b/i.test(proof) && !/\bnot\s+the\s+heuristic\b/i.test(proof)) {
      return "AI analysis provider proof must not rely on the heuristic fallback.";
    }
    return null;
  },
  clipRanking: (proof) => {
    const required = [
      { label: "ranked clips", pattern: /\branked\b.*\bclips\b|\bclips\b.*\branked\b/i },
      { label: "church-aware scoring", pattern: /\bchurch[- ]aware\b|\bchurch\b.*\bscor/i },
      { label: "scripture/church subscores", pattern: /\bscripture\b|\bbiblical_usefulness\b|\btheological_clarity\b|\bpastoral_tone\b/ },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Clip ranking proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  branding: (proof) => {
    const required = [
      { label: "brand template", pattern: /\bbrand\b.*\btemplate\b|\btemplate\b.*\bbrand\b/i },
      { label: "applied", pattern: /\bapplied\b|\bapply\b/i },
      { label: "editor", pattern: /\beditor\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Branding proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  approvalNotification: (proof) => {
    const required = [
      { label: "real approval email or SMS", pattern: /\breal\b.*\bapproval\b.*\b(?:email|SMS)\b|\bapproval\b.*\b(?:email|SMS)\b/i },
      { label: "delivered", pattern: /\bdelivered\b|\bsent\b/i },
      { label: "SendGrid or Twilio", pattern: /\bsendgrid\b|\btwilio\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Approval notification proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  reviewApproval: (proof) => {
    const required = [
      { label: "secure /review/:token link", pattern: /\bsecure\b.*\/review\/(?::token|[^\s]+)|\/review\/(?::token|[^\s]+)/i },
      { label: "viewed", pattern: /\bviewed\b|\bopened\b/i },
      { label: "approved", pattern: /\bapproved\b|\bapproval\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Review approval proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  export: (proof) => {
    const required = [
      { label: "approved clip", pattern: /\bapproved\b.*\bclip\b|\bclip\b.*\bapproved\b/i },
      { label: "exported", pattern: /\bexport(?:ed)?\b/i },
      { label: "worker", pattern: /\bworker\b/i },
      { label: "MP4", pattern: /\bMP4\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Export proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  download: (proof) => {
    const required = [
      { label: "MP4", pattern: /\bMP4\b/i },
      { label: "downloaded", pattern: /\bdownload(?:ed)?\b/i },
      { label: "short-lived signed URL", pattern: /\bshort[- ]lived\b.*\bsigned\b.*\bURL\b|\bsigned\b.*\bURL\b.*\bshort[- ]lived\b/i },
      { label: "production storage", pattern: /\bproduction\b.*\bstorage\b|\b(?:S3|R2)\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Download proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  observability: (proof) => {
    const required = [
      { label: "/app/settings/operations", pattern: /\/app\/settings\/operations/i },
      { label: "upload", pattern: /\bupload\b/i },
      { label: "processing", pattern: /\bprocessing\b|\btranscription\b|\banalysis\b/i },
      { label: "approval", pattern: /\bapproval\b/i },
      { label: "export", pattern: /\bexport\b/i },
      { label: "billing", pattern: /\bbilling\b/i },
      { label: "worker", pattern: /\bworker\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Observability proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  ci: (proof) => {
    const required = [
      { label: "verify", pattern: /\bverify\b/i },
      { label: "integration", pattern: /\bintegration\b/i },
      { label: "e2e", pattern: /\be2e\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `CI proof must mention passing ${missing.join(", ")} gate(s).`;
    }
    return null;
  },
  billing: (proof) => {
    const required = [
      { label: "Stripe", pattern: /\bstripe\b/i },
      { label: "Checkout", pattern: /\bcheckout\b/i },
      { label: "Portal", pattern: /\bportal\b/i },
      { label: "webhook", pattern: /\bwebhook\b/i },
      { label: "workspace plan", pattern: /\bworkspace\b.*\bplan\b|\bplan\b.*\bworkspace\b/i },
      { label: "granted minutes", pattern: /\bgrant(?:ed)?\b.*\bminutes\b|\bminutes\b.*\bgrant(?:ed)?\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Billing proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
  usageLimits: (proof) => {
    const required = [
      { label: "insufficient minutes", pattern: /\binsufficient\b.*\bminutes\b|\bno\b.*\bminutes\b/i },
      { label: "blocked", pattern: /\bblocked\b|\brejected\b|\bprevented\b/i },
      { label: "no negative balance", pattern: /\bno\b.*\bnegative\b.*\bbalance\b|\bwithout\b.*\bnegative\b.*\bbalance\b/i },
    ];
    const missing = required.filter((item) => !item.pattern.test(proof)).map((item) => item.label);
    if (missing.length > 0) {
      return `Usage limit proof must mention: ${missing.join(", ")}.`;
    }
    return null;
  },
};

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
  const semanticError = isLaunchEvidenceItemKey(key) ? providerEvidenceChecks[key]?.(item.evidence) : null;
  if (semanticError) {
    return { name: key, status: "fail", message: semanticError };
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
