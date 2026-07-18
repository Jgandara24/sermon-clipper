import { NotificationStatus } from "@prisma/client";

export type EmailProviderInput = {
  apiKey: string;
  to: string;
  subject: string;
  text: string;
  fromEmail: string;
  fromName: string;
};

export type EmailProviderResult = {
  status: NotificationStatus;
  errorMessage?: string | null;
};

export async function sendViaResend(input: EmailProviderInput): Promise<EmailProviderResult> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${input.fromName} <${input.fromEmail}>`,
      to: [input.to],
      subject: input.subject,
      text: input.text,
    }),
  });

  if (!response.ok) {
    return { status: NotificationStatus.FAILED, errorMessage: await response.text() };
  }

  return { status: NotificationStatus.SENT };
}
