import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAlertThrottleForTests,
  dispatchOperationalAlertSafely,
} from "@/lib/observability/alerts";

const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));

function errorEvent(eventType = "export_failed") {
  return {
    category: "export" as const,
    eventType,
    severity: "error" as const,
    message: "Export render failed.",
    workspaceId: "ws_1",
  };
}

beforeEach(() => {
  __resetAlertThrottleForTests();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  process.env.OPERATIONS_ALERT_EMAIL = "ops@example.org";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.NOTIFICATIONS_FROM_EMAIL = "notify@example.org";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPERATIONS_ALERT_EMAIL;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFICATIONS_FROM_EMAIL;
  delete process.env.ALERTS_THROTTLE_MS;
});

describe("dispatchOperationalAlertSafely", () => {
  it("sends an email for an error-severity event", async () => {
    await dispatchOperationalAlertSafely(errorEvent());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.to).toEqual(["ops@example.org"]);
    expect(body.subject).toContain("export");
    expect(body.subject).toContain("export_failed");
  });

  it("ignores non-error severities", async () => {
    await dispatchOperationalAlertSafely({ ...errorEvent(), severity: "warning" });
    await dispatchOperationalAlertSafely({ ...errorEvent(), severity: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throttles repeats of the same category:eventType but not distinct event types", async () => {
    await dispatchOperationalAlertSafely(errorEvent());
    await dispatchOperationalAlertSafely(errorEvent());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await dispatchOperationalAlertSafely(errorEvent("export_upload_failed"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the alert email is not configured", async () => {
    delete process.env.OPERATIONS_ALERT_EMAIL;
    await dispatchOperationalAlertSafely(errorEvent());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws, even when the email provider call fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(dispatchOperationalAlertSafely(errorEvent())).resolves.toBeUndefined();
  });
});
