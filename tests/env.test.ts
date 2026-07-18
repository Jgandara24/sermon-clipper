import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authEmailFrom,
  env,
  envTimeoutMs,
  ffmpegPath,
  notificationsFromEmail,
  notificationsFromName,
  operationsAlertFromEmail,
} from "@/lib/env";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.STORAGE_PROVIDER;
  delete process.env.STORAGE_S3_REGION;
  delete process.env.EXPORT_MAX_CONCURRENT_JOBS;
  delete process.env.EXPORT_FILE_RETENTION_GRACE_MS;
  delete process.env.WORKER_POLL_INTERVAL_MS;
  delete process.env.ALERTS_THROTTLE_MS;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFICATIONS_FROM_EMAIL;
  delete process.env.NOTIFICATIONS_FROM_NAME;
  delete process.env.AUTH_EMAIL_FROM;
  delete process.env.AUTH_EMAIL_FROM_NAME;
  delete process.env.FFMPEG_PATH;
  delete process.env.ENV_TEST_TIMEOUT_MS;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("env accessor", () => {
  it("applies defaults when variables are unset", () => {
    expect(env.STORAGE_PROVIDER).toBe("local");
    expect(env.STORAGE_S3_REGION).toBe("auto");
    expect(env.EXPORT_MAX_CONCURRENT_JOBS).toBe(4);
    expect(env.WORKER_POLL_INTERVAL_MS).toBe(2000);
    expect(env.ALERTS_THROTTLE_MS).toBe(30 * 60 * 1000);
  });

  it("returns undefined for unset optional variables", () => {
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.NOTIFICATIONS_FROM_EMAIL).toBeUndefined();
    expect(env.WHISPER_MODEL_PATH).toBeUndefined();
  });

  it("re-reads process.env on every access (no memoization)", () => {
    expect(env.RESEND_API_KEY).toBeUndefined();
    process.env.RESEND_API_KEY = "re_test_key";
    expect(env.RESEND_API_KEY).toBe("re_test_key");
    delete process.env.RESEND_API_KEY;
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it("parses valid numeric overrides", () => {
    process.env.EXPORT_MAX_CONCURRENT_JOBS = "2.9";
    process.env.WORKER_POLL_INTERVAL_MS = "500";
    expect(env.EXPORT_MAX_CONCURRENT_JOBS).toBe(2); // floored positive int
    expect(env.WORKER_POLL_INTERVAL_MS).toBe(500);
  });

  it("falls back to the default on garbage or out-of-range numeric input", () => {
    process.env.EXPORT_MAX_CONCURRENT_JOBS = "not-a-number";
    expect(env.EXPORT_MAX_CONCURRENT_JOBS).toBe(4);

    process.env.EXPORT_MAX_CONCURRENT_JOBS = "0";
    expect(env.EXPORT_MAX_CONCURRENT_JOBS).toBe(4);

    process.env.EXPORT_FILE_RETENTION_GRACE_MS = "-1000";
    expect(env.EXPORT_FILE_RETENTION_GRACE_MS).toBe(30 * 24 * 60 * 60 * 1000);

    process.env.EXPORT_FILE_RETENTION_GRACE_MS = "0";
    expect(env.EXPORT_FILE_RETENTION_GRACE_MS).toBe(0); // zero grace is valid

    process.env.ALERTS_THROTTLE_MS = "garbage";
    expect(env.ALERTS_THROTTLE_MS).toBe(30 * 60 * 1000);
  });
});

describe("fallback chains", () => {
  it("notification sender prefers NOTIFICATIONS_FROM_EMAIL, then AUTH_EMAIL_FROM", () => {
    expect(notificationsFromEmail()).toBeUndefined();

    process.env.AUTH_EMAIL_FROM = "auth@example.com";
    expect(notificationsFromEmail()).toBe("auth@example.com");

    process.env.NOTIFICATIONS_FROM_EMAIL = "clips@example.com";
    expect(notificationsFromEmail()).toBe("clips@example.com");
  });

  it("auth sender prefers AUTH_EMAIL_FROM, then NOTIFICATIONS_FROM_EMAIL", () => {
    process.env.NOTIFICATIONS_FROM_EMAIL = "clips@example.com";
    expect(authEmailFrom()).toBe("clips@example.com");

    process.env.AUTH_EMAIL_FROM = "auth@example.com";
    expect(authEmailFrom()).toBe("auth@example.com");
  });

  it("notification sender name falls back through AUTH_EMAIL_FROM_NAME to the app default", () => {
    expect(notificationsFromName()).toBe("Sermon Clipper");

    process.env.AUTH_EMAIL_FROM_NAME = "Auth Sender";
    expect(notificationsFromName()).toBe("Auth Sender");

    process.env.NOTIFICATIONS_FROM_NAME = "Clips Sender";
    expect(notificationsFromName()).toBe("Clips Sender");
  });

  it("operations alert sender uses || so an empty string falls through", () => {
    process.env.NOTIFICATIONS_FROM_EMAIL = "";
    process.env.AUTH_EMAIL_FROM = "auth@example.com";
    expect(operationsAlertFromEmail()).toBe("auth@example.com");
  });
});

describe("binary path and timeout helpers", () => {
  it("ffmpegPath falls back on unset and on empty string", () => {
    expect(ffmpegPath()).toBe("ffmpeg");
    process.env.FFMPEG_PATH = "";
    expect(ffmpegPath()).toBe("ffmpeg");
    process.env.FFMPEG_PATH = "/opt/bin/ffmpeg";
    expect(ffmpegPath()).toBe("/opt/bin/ffmpeg");
  });

  it("envTimeoutMs uses the override when positive, the default otherwise", () => {
    expect(envTimeoutMs("ENV_TEST_TIMEOUT_MS", 60_000)).toBe(60_000);
    process.env.ENV_TEST_TIMEOUT_MS = "1234";
    expect(envTimeoutMs("ENV_TEST_TIMEOUT_MS", 60_000)).toBe(1234);
    process.env.ENV_TEST_TIMEOUT_MS = "not-a-number";
    expect(envTimeoutMs("ENV_TEST_TIMEOUT_MS", 60_000)).toBe(60_000);
    process.env.ENV_TEST_TIMEOUT_MS = "-5";
    expect(envTimeoutMs("ENV_TEST_TIMEOUT_MS", 60_000)).toBe(60_000);
  });
});
