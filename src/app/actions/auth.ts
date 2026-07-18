"use server";

import { AuthProvider, NotificationStatus, WorkspaceRole } from "@prisma/client";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DEV_SESSION_COOKIE, getPrimaryWorkspaceForUser, requireCurrentUser } from "@/lib/auth";
import {
  AUTH_SESSION_COOKIE,
  consumeEmailOtpChallenge,
  createEmailOtpChallenge,
  EmailOtpRateLimitError,
  markEmailOtpDelivery,
  revokeSessionToken,
} from "@/lib/auth/email-otp";
import { sendEmailOtp } from "@/lib/auth/email-otp-delivery";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { prisma } from "@/lib/prisma";

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  next: z.string().optional(),
});

const otpVerifySchema = z.object({
  email: z.string().email().toLowerCase(),
  code: z.string().trim().regex(/^\d{6}$/),
  next: z.string().optional(),
});

const onboardingSchema = z.object({
  workspaceName: z.string().trim().min(2).max(80),
  timezone: z.string().trim().min(2).max(80),
  serviceDay: z.string().trim().min(2).max(24),
  sermonsPerWeek: z.coerce.number().int().min(1).max(2).default(1),
  secondServiceDay: z.string().trim().min(2).max(24).optional(),
});

function safeNextPath(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

export async function devLoginAction(formData: FormData) {
  if (process.env.NODE_ENV === "production") {
    redirect("/login?error=dev-disabled");
  }

  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    next: formData.get("next") || undefined,
  });

  if (!parsed.success) {
    redirect("/login?error=invalid-email");
  }

  const user = await prisma.user.upsert({
    where: { email: parsed.data.email },
    update: { authProvider: AuthProvider.DEV },
    create: {
      email: parsed.data.email,
      name: parsed.data.email === "demo@sermonclipper.local" ? "Demo Volunteer" : null,
      authProvider: AuthProvider.DEV,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(DEV_SESSION_COOKIE, user.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  const workspace = await getPrimaryWorkspaceForUser(user.id);
  const nextPath = safeNextPath(parsed.data.next);
  if (nextPath) {
    redirect(nextPath);
  }
  redirect(workspace ? "/app" : "/onboarding");
}

function setAuthSessionCookie(token: string, expiresAt: Date) {
  return {
    name: AUTH_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

export async function requestEmailOtpAction(formData: FormData) {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    next: formData.get("next") || undefined,
  });

  if (!parsed.success) {
    redirect("/login?error=invalid-email");
  }

  const nextParam = safeNextPath(parsed.data.next)
    ? `&next=${encodeURIComponent(parsed.data.next ?? "")}`
    : "";

  let challenge;
  try {
    challenge = await createEmailOtpChallenge(prisma, { email: parsed.data.email });
  } catch (error) {
    if (error instanceof EmailOtpRateLimitError) {
      await recordOperationalEventSafely(prisma, {
        category: "auth",
        eventType: "email_otp_rate_limited",
        severity: "warning",
        message: "Email OTP request was rate limited.",
        metadata: { email: parsed.data.email },
      });
      redirect(`/login?error=otp_rate_limited&email=${encodeURIComponent(parsed.data.email)}${nextParam}`);
    }
    throw error;
  }

  const delivery = await sendEmailOtp(challenge);
  await markEmailOtpDelivery(prisma, {
    challengeId: challenge.id,
    status: delivery.status,
    provider: delivery.provider,
    errorMessage: delivery.errorMessage,
  });
  await recordOperationalEventSafely(prisma, {
    category: "auth",
    eventType:
      delivery.status === NotificationStatus.SENT
        ? "email_otp_sent"
        : delivery.status === NotificationStatus.FAILED
          ? "email_otp_delivery_failed"
          : "email_otp_delivery_skipped",
    severity:
      delivery.status === NotificationStatus.FAILED
        ? "error"
        : delivery.status === NotificationStatus.SKIPPED
          ? "warning"
          : "info",
    message: `Email OTP delivery ${delivery.status.toLowerCase()}.`,
    metadata: {
      email: challenge.email,
      provider: delivery.provider,
      errorMessage: delivery.errorMessage ?? null,
    },
  });

  if (delivery.status === NotificationStatus.FAILED) {
    redirect(`/login?error=otp_delivery_failed&email=${encodeURIComponent(challenge.email)}${nextParam}`);
  }

  redirect(`/login?otp=sent&email=${encodeURIComponent(challenge.email)}${nextParam}`);
}

export async function verifyEmailOtpAction(formData: FormData) {
  const parsed = otpVerifySchema.safeParse({
    email: formData.get("email"),
    code: formData.get("code"),
    next: formData.get("next") || undefined,
  });

  if (!parsed.success) {
    redirect("/login?error=invalid-code");
  }

  const result = await consumeEmailOtpChallenge(prisma, parsed.data);
  if (!result.ok) {
    await recordOperationalEventSafely(prisma, {
      category: "auth",
      eventType: "email_otp_verify_failed",
      severity: "warning",
      message: "Email OTP verification failed.",
      metadata: { email: parsed.data.email, reason: result.reason },
    });
    const nextParam = safeNextPath(parsed.data.next)
      ? `&next=${encodeURIComponent(parsed.data.next ?? "")}`
      : "";
    redirect(`/login?error=${result.reason}&email=${encodeURIComponent(parsed.data.email)}${nextParam}`);
  }

  const cookieStore = await cookies();
  cookieStore.set(setAuthSessionCookie(result.token, result.expiresAt));
  cookieStore.delete(DEV_SESSION_COOKIE);
  await recordOperationalEventSafely(prisma, {
    category: "auth",
    eventType: "email_otp_verify_succeeded",
    message: "Email OTP verification succeeded.",
    metadata: { email: parsed.data.email, userId: result.userId },
  });

  const workspace = await getPrimaryWorkspaceForUser(result.userId);
  const nextPath = safeNextPath(parsed.data.next);
  if (nextPath) {
    redirect(nextPath);
  }
  redirect(workspace ? "/app" : "/onboarding");
}

export async function logoutAction() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(AUTH_SESSION_COOKIE)?.value;
  if (sessionToken) {
    await revokeSessionToken(prisma, sessionToken);
  }
  cookieStore.delete(AUTH_SESSION_COOKIE);
  cookieStore.delete(DEV_SESSION_COOKIE);
  redirect("/login");
}

export async function createWorkspaceAction(formData: FormData) {
  const user = await requireCurrentUser();
  const parsed = onboardingSchema.safeParse({
    workspaceName: formData.get("workspaceName"),
    timezone: formData.get("timezone"),
    serviceDay: formData.get("serviceDay"),
    sermonsPerWeek: formData.get("sermonsPerWeek") || undefined,
    secondServiceDay: formData.get("secondServiceDay") || undefined,
  });

  if (!parsed.success) {
    redirect("/onboarding?error=invalid-workspace");
  }

  await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: parsed.data.workspaceName,
        ownerId: user.id,
        settings: {
          churchProfile: {
            timezone: parsed.data.timezone,
            serviceDay: parsed.data.serviceDay,
            sermonsPerWeek: parsed.data.sermonsPerWeek,
            secondServiceDay:
              parsed.data.sermonsPerWeek === 2 ? (parsed.data.secondServiceDay || "Wednesday") : null,
            postsPerDay: 1,
          },
          defaultProcessingConfig: {
            language: "en",
            clipLength: "60-89s",
            genre: "sermon",
          },
        },
      },
    });

    await tx.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        role: WorkspaceRole.OWNER,
      },
    });
  });

  redirect("/app");
}
