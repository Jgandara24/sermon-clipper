import { NotificationChannel, NotificationStatus } from "@prisma/client";
import { sendViaResend } from "@/lib/notifications/email-provider";

type ApprovalNotificationInput = {
  channel: NotificationChannel;
  recipient: string;
  reviewUrl: string;
  clipTitle: string;
  workspaceName: string;
  requesterEmail?: string | null;
};

export type ApprovalNotificationResult = {
  provider: string;
  status: NotificationStatus;
  providerMessageId?: string | null;
  errorMessage?: string | null;
};

export async function sendApprovalNotification(
  input: ApprovalNotificationInput,
): Promise<ApprovalNotificationResult> {
  if (input.channel === NotificationChannel.EMAIL) {
    return sendApprovalEmail(input);
  }
  return sendApprovalSms(input);
}

async function sendApprovalEmail(
  input: ApprovalNotificationInput,
): Promise<ApprovalNotificationResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.NOTIFICATIONS_FROM_EMAIL;

  if (!apiKey || !fromEmail) {
    console.info(`[notifications] Review email skipped for ${input.recipient}: ${input.reviewUrl}`);
    return {
      provider: "resend",
      status: NotificationStatus.SKIPPED,
      errorMessage: "RESEND_API_KEY and NOTIFICATIONS_FROM_EMAIL are required to send email.",
    };
  }

  const result = await sendViaResend({
    apiKey,
    to: input.recipient,
    subject: `Review sermon clip: ${input.clipTitle}`,
    text: [
      `${input.workspaceName} sent a sermon clip for review.`,
      "",
      `Clip: ${input.clipTitle}`,
      input.requesterEmail ? `Requested by: ${input.requesterEmail}` : null,
      "",
      `Review link: ${input.reviewUrl}`,
    ]
      .filter(Boolean)
      .join("\n"),
    fromEmail,
    fromName: process.env.NOTIFICATIONS_FROM_NAME ?? "Sermon Clipper",
  });

  return { provider: "resend", ...result };
}

async function sendApprovalSms(input: ApprovalNotificationInput): Promise<ApprovalNotificationResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_MESSAGING_FROM;

  if (!accountSid || !authToken || !from) {
    console.info(`[notifications] Review SMS skipped for ${input.recipient}: ${input.reviewUrl}`);
    return {
      provider: "twilio",
      status: NotificationStatus.SKIPPED,
      errorMessage: "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_FROM are required to send SMS.",
    };
  }

  const body = new URLSearchParams({
    From: from,
    To: input.recipient,
    Body: `${input.workspaceName} sent "${input.clipTitle}" for review: ${input.reviewUrl}`,
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
  );

  const responseBody = await response.text();
  if (!response.ok) {
    return {
      provider: "twilio",
      status: NotificationStatus.FAILED,
      errorMessage: responseBody,
    };
  }

  let providerMessageId: string | null = null;
  try {
    providerMessageId = (JSON.parse(responseBody) as { sid?: string }).sid ?? null;
  } catch {
    providerMessageId = null;
  }

  return { provider: "twilio", status: NotificationStatus.SENT, providerMessageId };
}
