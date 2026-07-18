import { NotificationChannel, NotificationStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendApprovalNotification } from "@/lib/notifications/approval";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("approval notifications", () => {
  it("skips email delivery when Resend is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFICATIONS_FROM_EMAIL;

    const result = await sendApprovalNotification({
      channel: NotificationChannel.EMAIL,
      recipient: "pastor@example.com",
      reviewUrl: "https://example.com/review/token",
      clipTitle: "Peace Stays With Us",
      workspaceName: "First Baptist",
    });

    expect(result).toMatchObject({
      provider: "resend",
      status: NotificationStatus.SKIPPED,
    });
  });

  it("sends email through Resend when configured", async () => {
    process.env.RESEND_API_KEY = "resend-key";
    process.env.NOTIFICATIONS_FROM_EMAIL = "clips@example.com";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 202 }),
    );

    const result = await sendApprovalNotification({
      channel: NotificationChannel.EMAIL,
      recipient: "pastor@example.com",
      reviewUrl: "https://example.com/review/token",
      clipTitle: "Peace Stays With Us",
      workspaceName: "First Baptist",
      requesterEmail: "media@example.com",
    });

    expect(result.status).toBe(NotificationStatus.SENT);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer resend-key" }),
      }),
    );
  });

  it("sends SMS through Twilio when configured", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_MESSAGING_FROM = "+15555550100";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ sid: "SM123" }, { status: 201 }),
    );

    const result = await sendApprovalNotification({
      channel: NotificationChannel.SMS,
      recipient: "+15555550101",
      reviewUrl: "https://example.com/review/token",
      clipTitle: "Peace Stays With Us",
      workspaceName: "First Baptist",
    });

    expect(result).toMatchObject({
      provider: "twilio",
      status: NotificationStatus.SENT,
      providerMessageId: "SM123",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
