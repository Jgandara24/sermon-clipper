import { NotificationStatus, WorkspaceRole } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceInvitationToken,
  sendWorkspaceInvitationEmail,
  workspaceInvitationPath,
  workspaceInvitationUrl,
} from "@/lib/workspace-invitations";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("workspace invitations", () => {
  it("creates opaque URL-safe invitation tokens", () => {
    const token = createWorkspaceInvitationToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createWorkspaceInvitationToken()).not.toBe(token);
  });

  it("builds join paths and absolute URLs", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://clips.example.com/";
    expect(workspaceInvitationPath("abc123")).toBe("/join/abc123");
    expect(workspaceInvitationUrl("abc123")).toBe("https://clips.example.com/join/abc123");
  });

  it("logs and skips invitation delivery in development when Resend is not configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.RESEND_API_KEY;
    delete process.env.NOTIFICATIONS_FROM_EMAIL;
    delete process.env.AUTH_EMAIL_FROM;
    const infoMock = vi.spyOn(console, "info").mockImplementation(() => {});

    const result = await sendWorkspaceInvitationEmail({
      email: "editor@example.com",
      workspaceName: "First Church",
      inviterEmail: "owner@example.com",
      role: WorkspaceRole.EDITOR,
      invitationUrl: "https://clips.example.com/join/token",
      expiresAt: new Date("2026-07-21T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      provider: "development-log",
      status: NotificationStatus.SKIPPED,
    });
    expect(infoMock).toHaveBeenCalledWith(expect.stringContaining("https://clips.example.com/join/token"));
  });

  it("sends invitation email through Resend when configured", async () => {
    process.env.RESEND_API_KEY = "resend-key";
    process.env.NOTIFICATIONS_FROM_EMAIL = "clips@example.com";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));

    const result = await sendWorkspaceInvitationEmail({
      email: "editor@example.com",
      workspaceName: "First Church",
      inviterEmail: "owner@example.com",
      role: WorkspaceRole.EDITOR,
      invitationUrl: "https://clips.example.com/join/token",
      expiresAt: new Date("2026-07-21T12:00:00.000Z"),
    });

    expect(result).toEqual({ provider: "resend", status: NotificationStatus.SENT });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer resend-key" }),
      }),
    );
  });
});
