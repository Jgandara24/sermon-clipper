import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  checkAnalysisRoutingReadiness,
  checkDeploymentEnvironment,
  checkWorkerHeartbeatReadiness,
  getDeploymentMetadata,
  summarizeReadiness,
} from "@/lib/deployment/readiness";

function routingClient(options: {
  policy?: {
    classificationProvider: string;
    classificationModel: string;
    scoringProvider: string;
    scoringModel: string;
  } | null;
  prices?: Array<{ provider: string; model: string }>;
  failWith?: Error;
}): PrismaClient {
  return {
    analysisRoutingPolicy: {
      findFirst: async () => {
        if (options.failWith) throw options.failWith;
        if (!options.policy) return null;
        return {
          id: "policy-id",
          version: 1,
          name: "test policy",
          state: "ACTIVE",
          promptVersion: 1,
          schemaVersion: 1,
          ...options.policy,
        };
      },
    },
    analysisModelPrice: {
      findMany: async () =>
        (options.prices ?? []).map((price) => ({
          provider: price.provider,
          model: price.model,
          effectiveFrom: new Date("2026-01-01T00:00:00Z"),
          effectiveUntil: null,
          inputPerMillionUsd: new Prisma.Decimal(1),
          cacheReadPerMillionUsd: null,
          cacheWritePerMillionUsd: null,
          outputPerMillionUsd: new Prisma.Decimal(5),
          pricingSourceUrl: "https://example.test/pricing",
        })),
    },
  } as unknown as PrismaClient;
}

describe("deployment readiness", () => {
  it("accepts ElevenLabs Scribe as the production transcription provider", () => {
    const checks = checkDeploymentEnvironment({
      NODE_ENV: "production",
      ELEVENLABS_API_KEY: "scribe-test-key",
    });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "TRANSCRIPTION_PROVIDER", status: "ok" }),
      ]),
    );
  });

  it("reports the global publishing state without requiring it to be enabled", () => {
    for (const value of [undefined, "false", "TRUE", "malformed"]) {
      const checks = checkDeploymentEnvironment({ AUTOMATIC_PUBLISHING_ENABLED: value });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "AUTOMATIC_PUBLISHING_ENABLED",
            status: "ok",
            message: expect.stringContaining("disabled"),
          }),
        ]),
      );
    }

    const enabledChecks = checkDeploymentEnvironment({ AUTOMATIC_PUBLISHING_ENABLED: "true" });
    expect(enabledChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "AUTOMATIC_PUBLISHING_ENABLED",
          status: "ok",
          message: expect.stringContaining("enabled"),
        }),
      ]),
    );
  });

  it("fails production readiness without S3 storage and required secrets", () => {
    const checks = checkDeploymentEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://example",
      NEXT_PUBLIC_APP_URL: "https://clips.example.com",
    });

    expect(summarizeReadiness(checks)).toBe("fail");
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "MEDIA_URL_SECRET", status: "fail" }),
        expect.objectContaining({ name: "RESEND_API_KEY", status: "fail" }),
        expect.objectContaining({ name: "AUTH_EMAIL_FROM", status: "fail" }),
        expect.objectContaining({ name: "approval_notifications", status: "fail" }),
        expect.objectContaining({ name: "STRIPE_SECRET_KEY", status: "fail" }),
        expect.objectContaining({ name: "STRIPE_WEBHOOK_SECRET", status: "fail" }),
        expect.objectContaining({ name: "STRIPE_PRICE_PAID", status: "fail" }),
        expect.objectContaining({ name: "TRANSCRIPTION_PROVIDER", status: "fail" }),
        expect.objectContaining({ name: "ANALYSIS_PROVIDER_API_KEY", status: "fail" }),
        expect.objectContaining({ name: "STORAGE_PROVIDER", status: "fail" }),
      ]),
    );
  });

  it("accepts S3 production configuration and warns about server action key", () => {
    const checks = checkDeploymentEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://example",
      NEXT_PUBLIC_APP_URL: "https://clips.example.com",
      MEDIA_URL_SECRET: "x".repeat(32),
      RESEND_API_KEY: "resend-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      NOTIFICATIONS_FROM_EMAIL: "clips@example.com",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_PAID: "price_starter_123",
      WHISPER_MODEL_PATH: "/models/ggml-base.en.bin",
      ANTHROPIC_API_KEY: "sk-ant-123",
      STORAGE_PROVIDER: "s3",
      STORAGE_S3_BUCKET: "sermon-clipper-production",
      STORAGE_S3_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
      STORAGE_S3_ACCESS_KEY_ID: "key",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(summarizeReadiness(checks)).toBe("degraded");
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "STORAGE_PROVIDER", status: "ok" }),
        expect.objectContaining({ name: "STORAGE_S3_ENDPOINT", status: "ok" }),
        expect.objectContaining({ name: "approval_notifications", status: "ok" }),
        expect.objectContaining({ name: "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY", status: "warning" }),
        expect.objectContaining({ name: "deployment_commit", status: "warning" }),
      ]),
    );
  });

  it("fails production readiness when public app URL is not HTTPS", () => {
    const checks = checkDeploymentEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://example",
      NEXT_PUBLIC_APP_URL: "http://clips.example.com",
      MEDIA_URL_SECRET: "x".repeat(32),
      RESEND_API_KEY: "resend-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      NOTIFICATIONS_FROM_EMAIL: "clips@example.com",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_PAID: "price_starter_123",
      WHISPER_MODEL_PATH: "/models/ggml-base.en.bin",
      ANTHROPIC_API_KEY: "sk-ant-123",
      STORAGE_PROVIDER: "s3",
      STORAGE_S3_BUCKET: "sermon-clipper-production",
      STORAGE_S3_ACCESS_KEY_ID: "key",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(summarizeReadiness(checks)).toBe("fail");
    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "NEXT_PUBLIC_APP_URL", status: "fail" })]),
    );
  });

  it("accepts Twilio as the production approval notification channel", () => {
    const checks = checkDeploymentEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://example",
      NEXT_PUBLIC_APP_URL: "https://clips.example.com",
      MEDIA_URL_SECRET: "x".repeat(32),
      RESEND_API_KEY: "resend-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "twilio-token",
      TWILIO_MESSAGING_FROM: "+15555550100",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_PAID: "price_starter_123",
      WHISPER_MODEL_PATH: "/models/ggml-base.en.bin",
      ANTHROPIC_API_KEY: "sk-ant-123",
      STORAGE_PROVIDER: "s3",
      STORAGE_S3_BUCKET: "sermon-clipper-production",
      STORAGE_S3_ACCESS_KEY_ID: "key",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "approval_notifications", status: "ok" })]),
    );
  });

  it("fails production readiness when S3 endpoint is not HTTPS", () => {
    const checks = checkDeploymentEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://example",
      NEXT_PUBLIC_APP_URL: "https://clips.example.com",
      MEDIA_URL_SECRET: "x".repeat(32),
      RESEND_API_KEY: "resend-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      NOTIFICATIONS_FROM_EMAIL: "clips@example.com",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_PAID: "price_starter_123",
      WHISPER_MODEL_PATH: "/models/ggml-base.en.bin",
      ANTHROPIC_API_KEY: "sk-ant-123",
      STORAGE_PROVIDER: "s3",
      STORAGE_S3_BUCKET: "sermon-clipper-production",
      STORAGE_S3_ENDPOINT: "http://account-id.r2.cloudflarestorage.com",
      STORAGE_S3_ACCESS_KEY_ID: "key",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(summarizeReadiness(checks)).toBe("fail");
    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "STORAGE_S3_ENDPOINT", status: "fail" })]),
    );
  });

  it("fails production readiness when media URL secret is weak", () => {
    const checks = checkDeploymentEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://example",
      NEXT_PUBLIC_APP_URL: "https://clips.example.com",
      MEDIA_URL_SECRET: "short-secret",
      RESEND_API_KEY: "resend-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      NOTIFICATIONS_FROM_EMAIL: "clips@example.com",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_PAID: "price_starter_123",
      WHISPER_MODEL_PATH: "/models/ggml-base.en.bin",
      ANTHROPIC_API_KEY: "sk-ant-123",
      STORAGE_PROVIDER: "s3",
      STORAGE_S3_BUCKET: "sermon-clipper-production",
      STORAGE_S3_ACCESS_KEY_ID: "key",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(summarizeReadiness(checks)).toBe("fail");
    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "MEDIA_URL_SECRET", status: "fail" })]),
    );
  });

  it("fails production readiness when Stripe billing identifiers are placeholders", () => {
    const checks = checkDeploymentEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://example",
      NEXT_PUBLIC_APP_URL: "https://clips.example.com",
      MEDIA_URL_SECRET: "x".repeat(32),
      RESEND_API_KEY: "resend-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      NOTIFICATIONS_FROM_EMAIL: "clips@example.com",
      STRIPE_SECRET_KEY: "secret",
      STRIPE_WEBHOOK_SECRET: "webhook",
      STRIPE_PRICE_PAID: "starter",
      WHISPER_MODEL_PATH: "/models/ggml-base.en.bin",
      ANTHROPIC_API_KEY: "sk-ant-123",
      STORAGE_PROVIDER: "s3",
      STORAGE_S3_BUCKET: "sermon-clipper-production",
      STORAGE_S3_ACCESS_KEY_ID: "key",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(summarizeReadiness(checks)).toBe("fail");
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "STRIPE_SECRET_KEY", status: "fail" }),
        expect.objectContaining({ name: "STRIPE_WEBHOOK_SECRET", status: "fail" }),
        expect.objectContaining({ name: "STRIPE_PRICE_PAID", status: "fail" }),
      ]),
    );
  });

  it("fails production readiness without provider-backed transcription and AI analysis", () => {
    const checks = checkDeploymentEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://example",
      NEXT_PUBLIC_APP_URL: "https://clips.example.com",
      MEDIA_URL_SECRET: "x".repeat(32),
      RESEND_API_KEY: "resend-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      NOTIFICATIONS_FROM_EMAIL: "clips@example.com",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_PAID: "price_starter_123",
      STORAGE_PROVIDER: "s3",
      STORAGE_S3_BUCKET: "sermon-clipper-production",
      STORAGE_S3_ACCESS_KEY_ID: "key",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(summarizeReadiness(checks)).toBe("fail");
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "TRANSCRIPTION_PROVIDER", status: "fail" }),
        expect.objectContaining({ name: "ANALYSIS_PROVIDER_API_KEY", status: "fail" }),
      ]),
    );
  });

  it("reports deployment commit metadata when configured", () => {
    const metadata = getDeploymentMetadata({
      VERCEL_GIT_COMMIT_SHA: "abcdef1234567890",
    });

    expect(metadata).toEqual({
      commitSha: "abcdef1234567890",
      commitSource: "VERCEL_GIT_COMMIT_SHA",
    });
  });

  it("prefers explicit app commit metadata over provider defaults", () => {
    const metadata = getDeploymentMetadata({
      SERMON_CLIPPER_COMMIT_SHA: "1111111",
      VERCEL_GIT_COMMIT_SHA: "2222222",
    });

    expect(metadata).toEqual({
      commitSha: "1111111",
      commitSource: "SERMON_CLIPPER_COMMIT_SHA",
    });
  });

  it("fails production readiness when no worker heartbeat has been recorded", async () => {
    const client = {
      workerHeartbeat: {
        findFirst: async () => null,
      },
    };

    const checks = await checkWorkerHeartbeatReadiness(client as never, { NODE_ENV: "production" });

    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "worker_heartbeat", status: "fail" })]),
    );
  });

  it("fails production readiness when the latest worker heartbeat is stale", async () => {
    const client = {
      workerHeartbeat: {
        findFirst: async () => ({
          workerId: "worker-1",
          lastSeenAt: new Date("2026-07-07T20:00:00.000Z"),
        }),
      },
    };

    const checks = await checkWorkerHeartbeatReadiness(
      client as never,
      { NODE_ENV: "production", WORKER_HEARTBEAT_MAX_AGE_MS: "60000" },
      new Date("2026-07-07T20:02:00.000Z"),
    );

    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "worker_heartbeat", status: "fail" })]),
    );
  });

  it("accepts a recent production worker heartbeat", async () => {
    const client = {
      workerHeartbeat: {
        findFirst: async () => ({
          workerId: "worker-1",
          lastSeenAt: new Date("2026-07-07T20:00:30.000Z"),
        }),
      },
    };

    const checks = await checkWorkerHeartbeatReadiness(
      client as never,
      { NODE_ENV: "production", WORKER_HEARTBEAT_MAX_AGE_MS: "60000" },
      new Date("2026-07-07T20:01:00.000Z"),
    );

    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "worker_heartbeat", status: "ok" })]),
    );
  });
});

describe("analysis routing readiness", () => {
  const claudePolicy = {
    classificationProvider: "ANTHROPIC",
    classificationModel: "claude-haiku-4-5",
    scoringProvider: "ANTHROPIC",
    scoringModel: "claude-sonnet-5",
  };
  const claudePrices = [
    { provider: "ANTHROPIC", model: "claude-haiku-4-5" },
    { provider: "ANTHROPIC", model: "claude-sonnet-5" },
  ];

  it("passes when the active policy's stages are keyed and priced", async () => {
    const checks = await checkAnalysisRoutingReadiness(
      routingClient({ policy: claudePolicy, prices: claudePrices }),
      { NODE_ENV: "production", ANTHROPIC_API_KEY: "sk-ant-test" },
    );

    expect(checks).toEqual([
      expect.objectContaining({ name: "analysis_routing", status: "ok" }),
    ]);
  });

  it("degrades when the active policy's provider key is missing", async () => {
    // The env-only ANALYSIS_PROVIDER_API_KEY check accepts ANY one key; this catches a deploy
    // whose configured key does not match the provider the active policy actually routes to.
    const checks = await checkAnalysisRoutingReadiness(
      routingClient({
        policy: { ...claudePolicy, classificationProvider: "GOOGLE", classificationModel: "gemini-3.1-flash-lite" },
        prices: [...claudePrices, { provider: "GOOGLE", model: "gemini-3.1-flash-lite" }],
      }),
      { NODE_ENV: "production", ANTHROPIC_API_KEY: "sk-ant-test" },
    );

    expect(checks).toEqual([
      expect.objectContaining({
        name: "analysis_routing",
        status: "warning",
        message: expect.stringContaining("GEMINI_API_KEY"),
      }),
    ]);
  });

  it("degrades when an active stage has no currently effective price", async () => {
    const checks = await checkAnalysisRoutingReadiness(
      routingClient({
        policy: claudePolicy,
        prices: [{ provider: "ANTHROPIC", model: "claude-haiku-4-5" }],
      }),
      { NODE_ENV: "production", ANTHROPIC_API_KEY: "sk-ant-test" },
    );

    expect(checks).toEqual([
      expect.objectContaining({
        name: "analysis_routing",
        status: "warning",
        message: expect.stringContaining("no active price"),
      }),
    ]);
  });

  it("degrades when no active policy exists", async () => {
    const checks = await checkAnalysisRoutingReadiness(routingClient({ policy: null }), {
      NODE_ENV: "production",
    });

    expect(checks).toEqual([
      expect.objectContaining({ name: "analysis_routing", status: "warning" }),
    ]);
  });

  it("never returns fail, because /api/health is the Railway health check", async () => {
    // railway.json health-checks /api/health, and that route answers 503 on a failing readiness
    // status. A "fail" here would take the whole web service down — login, existing clips, the
    // billing page — for a fault that only stops new ANALYZE jobs on the worker. Prices are
    // effective-dated, so an end-dated price with no successor would arm that outage on a
    // timestamp with no deploy involved. smoke:production is where this hard-fails a release.
    const unusable = [
      routingClient({ policy: null }),
      routingClient({ policy: claudePolicy, prices: [] }),
      routingClient({ failWith: new Error("database unavailable") }),
      routingClient({
        policy: {
          ...claudePolicy,
          classificationProvider: "HEURISTIC",
          classificationModel: "heuristic-v1",
        },
        prices: claudePrices,
      }),
    ];

    for (const client of unusable) {
      const checks = await checkAnalysisRoutingReadiness(client, {
        NODE_ENV: "production",
        ANTHROPIC_API_KEY: "sk-ant-test",
      });
      expect(checks[0].status).not.toBe("fail");
      expect(summarizeReadiness(checks)).toBe("degraded");
    }
  });

  it("degrades to a warning when the audit itself cannot run", async () => {
    const checks = await checkAnalysisRoutingReadiness(
      routingClient({ failWith: new Error("database unavailable") }),
      { NODE_ENV: "production" },
    );

    expect(checks).toEqual([
      expect.objectContaining({ name: "analysis_routing", status: "warning" }),
    ]);
  });

  it("reports informationally outside production", async () => {
    const checks = await checkAnalysisRoutingReadiness(routingClient({ policy: null }), {
      NODE_ENV: "test",
    });

    expect(checks).toEqual([
      expect.objectContaining({ name: "analysis_routing", status: "ok" }),
    ]);
  });
});
