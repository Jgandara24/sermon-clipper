import { NotificationStatus } from "@prisma/client";
import { authEmailFrom, authEmailFromName, env } from "@/lib/env";
import { sendViaResend } from "@/lib/notifications/email-provider";

export type EmailOtpDeliveryInput = {
  email: string;
  code: string;
  expiresAt: Date;
};

export type EmailOtpDeliveryResult = {
  provider: string;
  status: NotificationStatus;
  errorMessage?: string | null;
};

export async function sendEmailOtp(input: EmailOtpDeliveryInput): Promise<EmailOtpDeliveryResult> {
  const apiKey = env.RESEND_API_KEY;
  const fromEmail = authEmailFrom();
  const fromName = authEmailFromName();

  if (!apiKey || !fromEmail) {
    if (process.env.NODE_ENV !== "production") {
      console.info(`[auth] OTP for ${input.email}: ${input.code} (expires ${input.expiresAt.toISOString()})`);
      return {
        provider: "development-log",
        status: NotificationStatus.SKIPPED,
        errorMessage: "RESEND_API_KEY and AUTH_EMAIL_FROM/NOTIFICATIONS_FROM_EMAIL are required to send email.",
      };
    }

    return {
      provider: "resend",
      status: NotificationStatus.FAILED,
      errorMessage: "RESEND_API_KEY and AUTH_EMAIL_FROM/NOTIFICATIONS_FROM_EMAIL are required in production.",
    };
  }

  const result = await sendViaResend({
    apiKey,
    to: input.email,
    subject: "Your Sermon Clipper sign-in code",
    text: [
      "Use this code to sign in to Sermon Clipper:",
      "",
      input.code,
      "",
      `This code expires at ${input.expiresAt.toISOString()}.`,
      "If you did not request this code, you can ignore this email.",
    ].join("\n"),
    fromEmail,
    fromName,
  });

  return { provider: "resend", ...result };
}
