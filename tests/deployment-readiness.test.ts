import { describe, expect, it } from "vitest";
import { checkDeploymentEnvironment, getDeploymentMetadata, summarizeReadiness } from "@/lib/deployment/readiness";

describe("deployment readiness", () => {
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
        expect.objectContaining({ name: "SENDGRID_API_KEY", status: "fail" }),
        expect.objectContaining({ name: "AUTH_EMAIL_FROM", status: "fail" }),
        expect.objectContaining({ name: "approval_notifications", status: "fail" }),
        expect.objectContaining({ name: "STRIPE_SECRET_KEY", status: "fail" }),
        expect.objectContaining({ name: "STRIPE_WEBHOOK_SECRET", status: "fail" }),
        expect.objectContaining({ name: "STRIPE_PRICE_STARTER", status: "fail" }),
        expect.objectContaining({ name: "STRIPE_PRICE_PRO", status: "fail" }),
        expect.objectContaining({ name: "STORAGE_PROVIDER", status: "fail" }),
      ]),
    );
  });

  it("accepts S3 production configuration and warns about server action key", () => {
    const checks = checkDeploymentEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://example",
      NEXT_PUBLIC_APP_URL: "https://clips.example.com",
      MEDIA_URL_SECRET: "secret",
      SENDGRID_API_KEY: "sendgrid-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      NOTIFICATIONS_FROM_EMAIL: "clips@example.com",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_STARTER: "price_starter",
      STRIPE_PRICE_PRO: "price_pro",
      STORAGE_PROVIDER: "s3",
      STORAGE_S3_BUCKET: "sermon-clipper-production",
      STORAGE_S3_ACCESS_KEY_ID: "key",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(summarizeReadiness(checks)).toBe("degraded");
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "STORAGE_PROVIDER", status: "ok" }),
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
      MEDIA_URL_SECRET: "secret",
      SENDGRID_API_KEY: "sendgrid-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      NOTIFICATIONS_FROM_EMAIL: "clips@example.com",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_STARTER: "price_starter",
      STRIPE_PRICE_PRO: "price_pro",
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
      MEDIA_URL_SECRET: "secret",
      SENDGRID_API_KEY: "sendgrid-key",
      AUTH_EMAIL_FROM: "auth@example.com",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "twilio-token",
      TWILIO_MESSAGING_FROM: "+15555550100",
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_STARTER: "price_starter",
      STRIPE_PRICE_PRO: "price_pro",
      STORAGE_PROVIDER: "s3",
      STORAGE_S3_BUCKET: "sermon-clipper-production",
      STORAGE_S3_ACCESS_KEY_ID: "key",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "approval_notifications", status: "ok" })]),
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
});
