import { NotificationStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmailOtpCode,
  createSessionToken,
  hashSecret,
  normalizeEmail,
  safeCompareHash,
} from "@/lib/auth/email-otp";
import { sendEmailOtp } from "@/lib/auth/email-otp-delivery";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("email OTP auth helpers", () => {
  it("normalizes email addresses", () => {
    expect(normalizeEmail("  Pastor@Example.COM ")).toBe("pastor@example.com");
  });

  it("creates six-digit OTP codes", () => {
    expect(createEmailOtpCode()).toMatch(/^\d{6}$/);
  });

  it("creates opaque URL-safe session tokens", () => {
    const token = createSessionToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createSessionToken()).not.toBe(token);
  });

  it("hashes and verifies secrets without storing plaintext", () => {
    const hash = hashSecret("123456");
    expect(hash).not.toBe("123456");
    expect(safeCompareHash("123456", hash)).toBe(true);
    expect(safeCompareHash("654321", hash)).toBe(false);
  });
});

describe("email OTP delivery", () => {
  it("logs and skips delivery in development when SendGrid is not configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.SENDGRID_API_KEY;
    delete process.env.AUTH_EMAIL_FROM;
    delete process.env.NOTIFICATIONS_FROM_EMAIL;
    const infoMock = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = await sendEmailOtp({
      email: "pastor@example.com",
      code: "123456",
      expiresAt: new Date("2026-07-07T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      provider: "development-log",
      status: NotificationStatus.SKIPPED,
    });
    expect(infoMock).toHaveBeenCalledWith(expect.stringContaining("123456"));
  });

  it("fails closed in production when SendGrid is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.SENDGRID_API_KEY;
    delete process.env.AUTH_EMAIL_FROM;
    delete process.env.NOTIFICATIONS_FROM_EMAIL;
    const infoMock = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = await sendEmailOtp({
      email: "pastor@example.com",
      code: "123456",
      expiresAt: new Date("2026-07-07T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      provider: "sendgrid",
      status: NotificationStatus.FAILED,
    });
    expect(infoMock).not.toHaveBeenCalled();
  });

  it("sends through SendGrid when configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.SENDGRID_API_KEY = "sendgrid-key";
    process.env.AUTH_EMAIL_FROM = "auth@example.com";
    process.env.AUTH_EMAIL_FROM_NAME = "Sermon Clipper Auth";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));

    const result = await sendEmailOtp({
      email: "pastor@example.com",
      code: "123456",
      expiresAt: new Date("2026-07-07T12:00:00.000Z"),
    });

    expect(result).toEqual({ provider: "sendgrid", status: NotificationStatus.SENT });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sendgrid.com/v3/mail/send",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sendgrid-key" }),
      }),
    );
  });
});
