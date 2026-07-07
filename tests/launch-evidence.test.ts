import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLaunchEvidenceTemplate,
  launchEvidenceItems,
  recordLaunchEvidenceItem,
  validateLaunchEvidence,
  validateLaunchEvidenceItemProof,
  type LaunchEvidence,
} from "@/lib/deployment/launch-evidence";

function completeEvidence(): LaunchEvidence {
  const evidenceByKey: Record<string, string> = {
    healthCheck:
      "curl -fsS https://clips.example.org/api/health returned status ok, all checks ok including worker_heartbeat ok, and commitSha fe09434.",
    productionSmoke:
      "npm run smoke:production -- --base-url https://clips.example.org --commit-sha fe09434 returned status ok.",
    webProcess: "Vercel deployment platform shows the web process running deployed commit SHA fe09434.",
    databaseMigrations:
      "npm run db:migrate:deploy completed successfully against the production database for commit fe09434.",
    authEmail: "Real user owner@example.org received an email OTP through SendGrid and verified the code to sign in.",
    workspaceCreate: "Real user owner@example.org created production workspace ws_prod_123.",
    workspaceJoin:
      "Second user editor@example.org accepted the workspace invitation through /join/prod-token and joined the workspace.",
    upload: "Sermon video uploaded to Cloudflare R2 S3 bucket sermon-clipper-production under src/ws_prod_123/source.mp4.",
    processing:
      "Operations events show FINALIZE, PROBE, TRANSCRIBE, and ANALYZE completed successfully for project prod_project_123.",
    workerProcess:
      "Deployment platform shows worker-1 running with WORKER_ID=worker-1, ffmpeg, ffprobe, whisper-cli, readable WHISPER_MODEL_PATH /models/ggml-base.en.bin, and worker_heartbeat ok.",
    transcriptionProvider:
      "Operations metadata shows provider whisper_cpp, source audio, and configured WHISPER_MODEL_PATH /models/ggml-base.en.bin in production.",
    analysisProvider:
      "Operations metadata shows provider claude-sonnet-5 with ANTHROPIC_API_KEY-backed scoring, not the heuristic fallback.",
    clipRanking:
      "Ranked clips appeared with church-aware scoring, scripture relevance, biblical_usefulness, theological_clarity, and pastoral_tone subscores.",
    branding: "Brand template Sunday Lower Third was applied in the production editor to the ranked clip.",
    approvalNotification:
      "Real approval email was sent through SendGrid and delivered to approver@example.org for project prod_project_123.",
    reviewApproval:
      "Secure /review/prod-review-token link was viewed by approver@example.org and approved for export.",
    export: "Approved clip prod_clip_123 exported through worker-1 as MP4 export prod_export_123.",
    download:
      "MP4 prod_export_123 downloaded through a short-lived signed URL from Cloudflare R2 production storage.",
    billing:
      "Stripe Checkout and Portal were opened, Stripe webhook updated the workspace plan, and granted minutes appeared in the ledger.",
    usageLimits:
      "Insufficient minutes upload was blocked without negative balance; operations showed rejected billing-limit event.",
    observability:
      "/app/settings/operations showed upload, processing, approval, export, billing, and worker events for project prod_project_123.",
    ci: "CI passed verify, integration, and e2e jobs for commit fe09434.",
  };

  return {
    deploymentUrl: "https://clips.example.org",
    commitSha: "fe09434",
    verifiedAt: "2026-07-07T20:00:00Z",
    verifiedBy: "Launch operator",
    items: Object.fromEntries(
      launchEvidenceItems.map((item) => [
        item.key,
        { status: "passed", evidence: evidenceByKey[item.key] ?? `${item.label} proof captured in production.` },
      ]),
    ),
  };
}

describe("launch evidence validation", () => {
  it("passes when every Phase 8 launch item has proof", () => {
    const result = validateLaunchEvidence(completeEvidence());

    expect(result.status).toBe("ok");
    expect(result.checks.every((check) => check.status === "ok")).toBe(true);
  });

  it("fails when the deployment URL is not HTTPS", () => {
    const evidence = completeEvidence();
    evidence.deploymentUrl = "http://clips.example.org";

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "deploymentUrl", status: "fail" })]),
    );
  });

  it("fails when verifiedAt is not a parseable timestamp", () => {
    const evidence = completeEvidence();
    evidence.verifiedAt = "launch day";

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "verifiedAt", status: "fail" })]),
    );
  });

  it("fails when unknown evidence item keys are present", () => {
    const evidence = completeEvidence();
    evidence.items.billingg = { status: "passed", evidence: "Misspelled billing proof." };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "items", status: "fail" })]));
  });

  it("fails when an evidence item is missing proof", () => {
    const evidence = completeEvidence();
    evidence.items.export = { status: "passed", evidence: "" };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "export", status: "fail" })]));
  });

  it("fails when an evidence item proof is too short to be useful", () => {
    const evidence = completeEvidence();
    evidence.items.download = { status: "passed", evidence: "done" };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "download", status: "fail" })]),
    );
  });

  it("fails when an evidence item is not marked passed", () => {
    const evidence = completeEvidence();
    evidence.items.billing = { status: "failed", evidence: "Stripe webhook did not arrive." };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "billing", status: "fail" })]));
  });

  it("fails when passed evidence still contains placeholder text", () => {
    const evidence = completeEvidence();
    evidence.items.healthCheck = { status: "passed", evidence: "TODO: Paste health check output here." };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "healthCheck", status: "fail" })]),
    );
  });

  it("fails when health check proof does not mention readiness and commit output", () => {
    const evidence = completeEvidence();
    evidence.items.healthCheck = {
      status: "passed",
      evidence: "The health endpoint worked.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "healthCheck", status: "fail" })]),
    );
  });

  it("fails when production smoke proof does not mention smoke command, URL, status, and commit", () => {
    const evidence = completeEvidence();
    evidence.items.productionSmoke = {
      status: "passed",
      evidence: "Production smoke passed.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "productionSmoke", status: "fail" })]),
    );
  });

  it("fails when web process proof does not mention platform, running web process, and commit", () => {
    const evidence = completeEvidence();
    evidence.items.webProcess = {
      status: "passed",
      evidence: "The app is deployed.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "webProcess", status: "fail" })]),
    );
  });

  it("fails when database migration proof does not mention production migrate deploy success", () => {
    const evidence = completeEvidence();
    evidence.items.databaseMigrations = {
      status: "passed",
      evidence: "Migrations are current.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "databaseMigrations", status: "fail" })]),
    );
  });

  it("fails when auth email proof does not mention OTP, SendGrid, and verification", () => {
    const evidence = completeEvidence();
    evidence.items.authEmail = {
      status: "passed",
      evidence: "A user signed in successfully.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "authEmail", status: "fail" })]),
    );
  });

  it("fails when workspace create proof does not mention a real user creating a workspace", () => {
    const evidence = completeEvidence();
    evidence.items.workspaceCreate = {
      status: "passed",
      evidence: "Workspace exists in production.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "workspaceCreate", status: "fail" })]),
    );
  });

  it("fails when workspace join proof does not mention second-user invitation acceptance", () => {
    const evidence = completeEvidence();
    evidence.items.workspaceJoin = {
      status: "passed",
      evidence: "Team access works.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "workspaceJoin", status: "fail" })]),
    );
  });

  it("fails when upload proof does not mention sermon video and S3/R2 bucket", () => {
    const evidence = completeEvidence();
    evidence.items.upload = {
      status: "passed",
      evidence: "Upload worked in production.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "upload", status: "fail" })]),
    );
  });

  it("fails when processing proof does not mention every required stage", () => {
    const evidence = completeEvidence();
    evidence.items.processing = {
      status: "passed",
      evidence: "Processing completed in production.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "processing", status: "fail" })]),
    );
  });

  it("fails when worker process proof does not mention runtime prerequisites", () => {
    const evidence = completeEvidence();
    evidence.items.workerProcess = {
      status: "passed",
      evidence: "Deployment platform shows one worker process is running.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "workerProcess", status: "fail" })]),
    );
  });

  it("fails when transcription provider proof does not mention Whisper model configuration", () => {
    const evidence = completeEvidence();
    evidence.items.transcriptionProvider = {
      status: "passed",
      evidence: "The transcript completed in production with provider metadata visible.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "transcriptionProvider", status: "fail" })]),
    );
  });

  it("fails when analysis provider proof relies on heuristic scoring", () => {
    const evidence = completeEvidence();
    evidence.items.analysisProvider = {
      status: "passed",
      evidence: "Operations metadata shows heuristic-v1 scoring and no Claude provider call.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "analysisProvider", status: "fail" })]),
    );
  });

  it("fails when clip ranking proof does not mention church-aware scripture scoring", () => {
    const evidence = completeEvidence();
    evidence.items.clipRanking = {
      status: "passed",
      evidence: "Clips appeared in production.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "clipRanking", status: "fail" })]),
    );
  });

  it("fails when branding proof does not mention applying a brand template in the editor", () => {
    const evidence = completeEvidence();
    evidence.items.branding = {
      status: "passed",
      evidence: "Branding worked in production.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "branding", status: "fail" })]),
    );
  });

  it("fails when approval notification proof does not mention real delivery through a provider", () => {
    const evidence = completeEvidence();
    evidence.items.approvalNotification = {
      status: "passed",
      evidence: "The approver was notified.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "approvalNotification", status: "fail" })]),
    );
  });

  it("fails when review approval proof does not mention viewing and approving the review link", () => {
    const evidence = completeEvidence();
    evidence.items.reviewApproval = {
      status: "passed",
      evidence: "The review workflow worked.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "reviewApproval", status: "fail" })]),
    );
  });

  it("fails when export proof does not mention an approved clip exported by the worker as MP4", () => {
    const evidence = completeEvidence();
    evidence.items.export = {
      status: "passed",
      evidence: "Export completed.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "export", status: "fail" })]));
  });

  it("fails when download proof does not mention MP4 download through a short-lived signed storage URL", () => {
    const evidence = completeEvidence();
    evidence.items.download = {
      status: "passed",
      evidence: "Download worked from production.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "download", status: "fail" })]),
    );
  });

  it("fails when CI proof does not mention every required gate", () => {
    const evidence = completeEvidence();
    evidence.items.ci = {
      status: "passed",
      evidence: "CI passed for this commit.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "ci", status: "fail" })]),
    );
  });

  it("fails when billing proof does not mention Stripe workflow and minute grants", () => {
    const evidence = completeEvidence();
    evidence.items.billing = {
      status: "passed",
      evidence: "Billing worked for the test workspace.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "billing", status: "fail" })]),
    );
  });

  it("fails when usage limit proof does not mention blocked insufficient minutes without negative balance", () => {
    const evidence = completeEvidence();
    evidence.items.usageLimits = {
      status: "passed",
      evidence: "Limits behaved correctly.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "usageLimits", status: "fail" })]),
    );
  });

  it("fails when observability proof does not mention all required operations categories", () => {
    const evidence = completeEvidence();
    evidence.items.observability = {
      status: "passed",
      evidence: "/app/settings/operations showed events.",
    };

    const result = validateLaunchEvidence(evidence);

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "observability", status: "fail" })]),
    );
  });

  it("fails when expected commit does not match evidence commit", () => {
    const result = validateLaunchEvidence(completeEvidence(), { expectedCommitSha: "abc1234" });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "commitShaMatches", status: "fail" })]),
    );
  });

  it("fails when expected deployment URL does not match evidence deployment URL", () => {
    const result = validateLaunchEvidence(completeEvidence(), {
      expectedDeploymentUrl: "https://staging-clips.example.org",
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "deploymentUrlMatches", status: "fail" })]),
    );
  });

  it("passes deployment URL matching with trailing slash differences", () => {
    const result = validateLaunchEvidence(completeEvidence(), {
      expectedDeploymentUrl: "https://clips.example.org/",
    });

    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "deploymentUrlMatches", status: "ok" })]),
    );
  });

  it("passes commit matching when either SHA is a prefix of the other", () => {
    const evidence = completeEvidence();
    evidence.commitSha = "fe09434abcdef";

    const result = validateLaunchEvidence(evidence, { expectedCommitSha: "fe09434" });

    expect(result.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "commitShaMatches", status: "ok" })]),
    );
  });

  it("creates a fail-closed evidence template for every launch item", () => {
    const template = createLaunchEvidenceTemplate({
      deploymentUrl: "https://clips.example.org",
      commitSha: "40aa4ff",
      verifiedAt: "2026-07-07T20:00:00Z",
      verifiedBy: "Launch operator",
    });

    expect(Object.keys(template.items).sort()).toEqual(launchEvidenceItems.map((item) => item.key).sort());
    expect(Object.values(template.items).every((item) => item?.status === "failed")).toBe(true);
    expect(template.items.productionSmoke?.evidence).toContain("https://clips.example.org");
    expect(validateLaunchEvidence(template).status).toBe("fail");
  });

  it("keeps the tracked example evidence file aligned with required launch items", () => {
    const examplePath = path.join(process.cwd(), "docs", "phase8-launch-evidence.example.json");
    const example = JSON.parse(readFileSync(examplePath, "utf-8")) as LaunchEvidence;

    expect(Object.keys(example.items).sort()).toEqual(launchEvidenceItems.map((item) => item.key).sort());
    expect(validateLaunchEvidence(example).status).toBe("fail");
  });

  it("records a single launch evidence item without changing other items", () => {
    const template = createLaunchEvidenceTemplate({
      deploymentUrl: "https://clips.example.org",
      commitSha: "40aa4ff",
      verifiedAt: "2026-07-07T20:00:00Z",
      verifiedBy: "Launch operator",
    });

    const updated = recordLaunchEvidenceItem({
      evidence: template,
      itemKey: "workspaceCreate",
      proof: "Created workspace sc_prod_123 as owner@example.org.",
      verifiedAt: "2026-07-07T21:00:00Z",
    });

    expect(updated.verifiedAt).toBe("2026-07-07T21:00:00Z");
    expect(updated.items.workspaceCreate).toEqual({
      status: "passed",
      evidence: "Created workspace sc_prod_123 as owner@example.org.",
    });
    expect(updated.items.workspaceJoin?.status).toBe("failed");
  });

  it("validates a single item proof before launch evidence recording writes it", () => {
    const valid = validateLaunchEvidenceItemProof(
      "download",
      "MP4 prod_export_123 downloaded through a short-lived signed URL from Cloudflare R2 production storage.",
    );
    const invalid = validateLaunchEvidenceItemProof("download", "Download worked.");

    expect(valid).toEqual(expect.objectContaining({ name: "download", status: "ok" }));
    expect(invalid).toEqual(expect.objectContaining({ name: "download", status: "fail" }));
  });

  it("fails single item proof validation for unknown keys", () => {
    const result = validateLaunchEvidenceItemProof("downloadn", "Typo should fail.");

    expect(result).toEqual(expect.objectContaining({ name: "downloadn", status: "fail" }));
  });

  it("does not write invalid passed evidence through the record CLI", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "launch-evidence-"));
    const evidencePath = path.join(tmpDir, "phase8-launch-evidence.json");
    const template = createLaunchEvidenceTemplate({
      deploymentUrl: "https://clips.example.org",
      commitSha: "40aa4ff",
      verifiedAt: "2026-07-07T20:00:00Z",
      verifiedBy: "Launch operator",
    });
    writeFileSync(evidencePath, `${JSON.stringify(template, null, 2)}\n`);
    const before = readFileSync(evidencePath, "utf-8");

    try {
      expect(() =>
        execFileSync(
          path.join(process.cwd(), "node_modules", ".bin", "tsx"),
          [
            "scripts/record-launch-evidence.ts",
            "--file",
            evidencePath,
            "--item",
            "download",
            "--evidence",
            "Download worked.",
          ],
          { cwd: process.cwd(), encoding: "utf-8", stdio: "pipe" },
        ),
      ).toThrow();
      expect(readFileSync(evidencePath, "utf-8")).toBe(before);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown launch evidence item keys when recording evidence", () => {
    expect(() =>
      recordLaunchEvidenceItem({
        evidence: completeEvidence(),
        itemKey: "workspaceCreat",
        proof: "Typo should fail.",
        verifiedAt: "2026-07-07T21:00:00Z",
      }),
    ).toThrow("Unknown launch evidence item");
  });
});
