import { describe, expect, it } from "vitest";
import { checkDeploymentEnvironment, summarizeReadiness } from "@/lib/deployment/readiness";

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
      STORAGE_PROVIDER: "s3",
      STORAGE_S3_BUCKET: "sermon-clipper-production",
      STORAGE_S3_ACCESS_KEY_ID: "key",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    });

    expect(summarizeReadiness(checks)).toBe("degraded");
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "STORAGE_PROVIDER", status: "ok" }),
        expect.objectContaining({ name: "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY", status: "warning" }),
      ]),
    );
  });
});
