import { describe, expect, it } from "vitest";
import {
  createEmailOtpCode,
  createSessionToken,
  hashSecret,
  normalizeEmail,
  safeCompareHash,
} from "@/lib/auth/email-otp";

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
