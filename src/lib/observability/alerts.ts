import { NotificationStatus } from "@prisma/client";
import { env, operationsAlertFromEmail } from "@/lib/env";
import { sendViaResend } from "@/lib/notifications/email-provider";
import type { OperationalEventInput } from "@/lib/observability/operational-events";

/**
 * Error-severity operational events email the operator directly: with no on-call team, an alert
 * nobody is looking at is not an alert. Throttled per category:eventType so an error storm
 * (e.g. every export failing) sends one email per window, not hundreds. The throttle is
 * in-process — web and worker each alert at most once per window, which is acceptable
 * double-delivery for a two-process deployment, not a correctness concern.
 */
const lastAlertAt = new Map<string, number>();

export function __resetAlertThrottleForTests() {
  lastAlertAt.clear();
}

export async function dispatchOperationalAlertSafely(input: OperationalEventInput): Promise<void> {
  try {
    if ((input.severity ?? "info") !== "error") return;

    const to = env.OPERATIONS_ALERT_EMAIL;
    const apiKey = env.RESEND_API_KEY;
    const fromEmail = operationsAlertFromEmail();
    // Unconfigured (local dev, CI): the operational event row is still the durable record.
    if (!to || !apiKey || !fromEmail) return;

    const throttleMs = env.ALERTS_THROTTLE_MS;
    const key = `${input.category}:${input.eventType}`;
    const now = Date.now();
    const last = lastAlertAt.get(key);
    if (last !== undefined && now - last < throttleMs) return;
    lastAlertAt.set(key, now);

    const lines = [
      input.message,
      "",
      `category: ${input.category}`,
      `event: ${input.eventType}`,
      input.workspaceId ? `workspace: ${input.workspaceId}` : null,
      input.projectId ? `project: ${input.projectId}` : null,
      input.jobId ? `job: ${input.jobId}` : null,
      input.exportJobId ? `export job: ${input.exportJobId}` : null,
      "",
      "Details: /app/settings/operations",
      `Further ${key} alerts are muted for ${Math.round(throttleMs / 60000)} minutes.`,
    ].filter((line): line is string => line !== null);

    const result = await sendViaResend({
      apiKey,
      to,
      fromEmail,
      fromName: env.NOTIFICATIONS_FROM_EMAIL_NAME || "Sermon Clipper Ops",
      subject: `[sermon-clipper] ${input.category} error: ${input.eventType}`,
      text: lines.join("\n"),
    });
    if (result.status !== NotificationStatus.SENT) {
      console.error("[observability] alert email failed to send", result.errorMessage);
    }
  } catch (error) {
    console.error("[observability] failed to dispatch operational alert", error);
  }
}
