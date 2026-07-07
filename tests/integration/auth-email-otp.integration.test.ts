import { AuthProvider, NotificationStatus, PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  consumeEmailOtpChallenge,
  createEmailOtpChallenge,
  EmailOtpRateLimitError,
  hashSecret,
  markEmailOtpDelivery,
  MAX_EMAIL_OTP_ATTEMPTS,
  MAX_EMAIL_OTP_REQUESTS_PER_WINDOW,
} from "@/lib/auth/email-otp";

const prisma = new PrismaClient();
const emailsToDelete: string[] = [];

function uniqueEmail() {
  const email = `otp-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  emailsToDelete.push(email);
  return email;
}

afterAll(async () => {
  if (emailsToDelete.length > 0) {
    await prisma.authSession.deleteMany({ where: { user: { email: { in: emailsToDelete } } } });
    await prisma.user.deleteMany({ where: { email: { in: emailsToDelete } } });
    await prisma.emailOtpChallenge.deleteMany({ where: { email: { in: emailsToDelete } } });
  }
  await prisma.$disconnect();
});

describe("email OTP integration", () => {
  it("consumes a valid code, creates an email OTP user, and stores only a hashed session token", async () => {
    const email = uniqueEmail();
    const challenge = await createEmailOtpChallenge(prisma, { email });

    const result = await consumeEmailOtpChallenge(prisma, { email, code: challenge.code });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.authProvider).toBe(AuthProvider.EMAIL_OTP);

    const session = await prisma.authSession.findFirstOrThrow({ where: { userId: user.id } });
    expect(session.tokenHash).toBe(hashSecret(result.token));
    expect(session.tokenHash).not.toBe(result.token);
    expect(session.revokedAt).toBeNull();

    const consumed = await prisma.emailOtpChallenge.findFirstOrThrow({ where: { email } });
    expect(consumed.consumedAt).not.toBeNull();
  });

  it("increments attempts and blocks after too many invalid codes", async () => {
    const email = uniqueEmail();
    await createEmailOtpChallenge(prisma, { email });

    for (let i = 0; i < MAX_EMAIL_OTP_ATTEMPTS; i += 1) {
      const result = await consumeEmailOtpChallenge(prisma, { email, code: "000000" });
      expect(result).toEqual({ ok: false, reason: "invalid_code" });
    }

    const blocked = await consumeEmailOtpChallenge(prisma, { email, code: "000000" });
    expect(blocked).toEqual({ ok: false, reason: "too_many_attempts" });
  });

  it("rate limits repeated OTP requests inside the request window", async () => {
    const email = uniqueEmail();

    for (let i = 0; i < MAX_EMAIL_OTP_REQUESTS_PER_WINDOW; i += 1) {
      await createEmailOtpChallenge(prisma, { email });
    }

    await expect(createEmailOtpChallenge(prisma, { email })).rejects.toBeInstanceOf(EmailOtpRateLimitError);
  });

  it("records OTP delivery status and provider audit fields", async () => {
    const email = uniqueEmail();
    const challenge = await createEmailOtpChallenge(prisma, { email });
    const sentAt = new Date("2026-07-07T12:00:00.000Z");

    const updated = await markEmailOtpDelivery(prisma, {
      challengeId: challenge.id,
      status: NotificationStatus.SENT,
      provider: "sendgrid",
      now: sentAt,
    });

    expect(updated.deliveryStatus).toBe(NotificationStatus.SENT);
    expect(updated.deliveryProvider).toBe("sendgrid");
    expect(updated.deliveryErrorMessage).toBeNull();
    expect(updated.sentAt?.toISOString()).toBe(sentAt.toISOString());
  });
});
