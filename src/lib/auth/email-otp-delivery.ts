import { NotificationStatus } from "@prisma/client";

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
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.AUTH_EMAIL_FROM ?? process.env.NOTIFICATIONS_FROM_EMAIL;
  const fromName = process.env.AUTH_EMAIL_FROM_NAME ?? process.env.NOTIFICATIONS_FROM_NAME ?? "Sermon Clipper";

  if (!apiKey || !fromEmail) {
    if (process.env.NODE_ENV !== "production") {
      console.info(`[auth] OTP for ${input.email}: ${input.code} (expires ${input.expiresAt.toISOString()})`);
      return {
        provider: "development-log",
        status: NotificationStatus.SKIPPED,
        errorMessage: "SENDGRID_API_KEY and AUTH_EMAIL_FROM/NOTIFICATIONS_FROM_EMAIL are required to send email.",
      };
    }

    return {
      provider: "sendgrid",
      status: NotificationStatus.FAILED,
      errorMessage: "SENDGRID_API_KEY and AUTH_EMAIL_FROM/NOTIFICATIONS_FROM_EMAIL are required in production.",
    };
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: input.email }],
          subject: "Your Sermon Clipper sign-in code",
        },
      ],
      from: { email: fromEmail, name: fromName },
      content: [
        {
          type: "text/plain",
          value: [
            "Use this code to sign in to Sermon Clipper:",
            "",
            input.code,
            "",
            `This code expires at ${input.expiresAt.toISOString()}.`,
            "If you did not request this code, you can ignore this email.",
          ].join("\n"),
        },
      ],
    }),
  });

  if (!response.ok) {
    return {
      provider: "sendgrid",
      status: NotificationStatus.FAILED,
      errorMessage: await response.text(),
    };
  }

  return { provider: "sendgrid", status: NotificationStatus.SENT };
}
