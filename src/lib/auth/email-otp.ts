import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { AuthProvider, type PrismaClient } from "@prisma/client";

export const AUTH_SESSION_COOKIE = "sermon_clipper_session";
export const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;
export const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_EMAIL_OTP_ATTEMPTS = 5;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createEmailOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function safeCompareHash(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function createEmailOtpChallenge(
  prisma: PrismaClient,
  params: { email: string; now?: Date },
): Promise<{ email: string; code: string; expiresAt: Date }> {
  const email = normalizeEmail(params.email);
  const now = params.now ?? new Date();
  const code = createEmailOtpCode();
  const expiresAt = new Date(now.getTime() + EMAIL_OTP_TTL_MS);

  await prisma.emailOtpChallenge.create({
    data: {
      email,
      codeHash: hashSecret(code),
      expiresAt,
    },
  });

  return { email, code, expiresAt };
}

export type ConsumeEmailOtpResult =
  | { ok: true; userId: string; token: string; expiresAt: Date }
  | { ok: false; reason: "not_found" | "expired" | "too_many_attempts" | "invalid_code" };

export async function consumeEmailOtpChallenge(
  prisma: PrismaClient,
  params: { email: string; code: string; now?: Date },
): Promise<ConsumeEmailOtpResult> {
  const email = normalizeEmail(params.email);
  const code = params.code.trim();
  const now = params.now ?? new Date();

  const challenge = await prisma.emailOtpChallenge.findFirst({
    where: { email, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!challenge) return { ok: false, reason: "not_found" };
  if (challenge.expiresAt <= now) return { ok: false, reason: "expired" };
  if (challenge.attempts >= MAX_EMAIL_OTP_ATTEMPTS) {
    return { ok: false, reason: "too_many_attempts" };
  }

  if (!safeCompareHash(code, challenge.codeHash)) {
    await prisma.emailOtpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "invalid_code" };
  }

  const token = createSessionToken();
  const expiresAt = new Date(now.getTime() + AUTH_SESSION_TTL_MS);

  const result = await prisma.$transaction(async (tx) => {
    await tx.emailOtpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: now, attempts: { increment: 1 } },
    });

    const user = await tx.user.upsert({
      where: { email },
      update: { authProvider: AuthProvider.EMAIL_OTP },
      create: { email, authProvider: AuthProvider.EMAIL_OTP },
    });

    await tx.authSession.create({
      data: {
        userId: user.id,
        tokenHash: hashSecret(token),
        expiresAt,
      },
    });

    return { userId: user.id };
  });

  return { ok: true, userId: result.userId, token, expiresAt };
}

export async function revokeSessionToken(prisma: PrismaClient, token: string, now = new Date()) {
  return prisma.authSession.updateMany({
    where: { tokenHash: hashSecret(token), revokedAt: null },
    data: { revokedAt: now },
  });
}
