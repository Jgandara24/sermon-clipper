import { WorkspaceAccessPlan } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { decideWorkspaceAccess, trialDates } from "@/lib/billing/access";

const startedAt = new Date("2026-08-01T12:00:00Z");
const dates = trialDates(startedAt);

describe("workspace access", () => {
  it("gives Trial the same product actions as Paid before expiry", () => {
    const trial = { accessPlan: WorkspaceAccessPlan.TRIAL, ...dates, paidAt: null };
    const paid = { accessPlan: WorkspaceAccessPlan.PAID, ...dates, paidAt: null };
    const at = new Date("2026-08-15T12:00:00Z");

    for (const action of ["import_media", "start_processing", "export_clip", "publish_post"] as const) {
      expect(decideWorkspaceAccess(trial, action, at).allowed).toBe(true);
      expect(decideWorkspaceAccess(paid, action, at).allowed).toBe(true);
    }
  });

  it("makes an expired Trial read-only", () => {
    const trial = { accessPlan: WorkspaceAccessPlan.TRIAL, ...dates, paidAt: null };
    const at = dates.trialEndsAt;

    expect(decideWorkspaceAccess(trial, "read", at).allowed).toBe(true);
    expect(decideWorkspaceAccess(trial, "manage_billing", at).allowed).toBe(true);
    expect(decideWorkspaceAccess(trial, "import_media", at)).toMatchObject({
      allowed: false,
      state: "trial_expired",
      reason: "trial_expired_read_only",
    });
  });

  it("starts a trial for exactly 30 days", () => {
    expect(dates.trialEndsAt.toISOString()).toBe("2026-08-31T12:00:00.000Z");
  });

  it("does not return a canceled subscription to an unfinished trial", () => {
    // Stripe cancellation maps the workspace back to accessPlan TRIAL. Without this rule a
    // church that upgraded on day 5 and canceled on day 10 would keep full free access until
    // day 30 — a cancellation must not refund unused trial days.
    const lapsed = {
      accessPlan: WorkspaceAccessPlan.TRIAL,
      ...dates,
      paidAt: new Date("2026-08-05T12:00:00Z"),
    };
    const duringOriginalTrial = new Date("2026-08-10T12:00:00Z");

    expect(decideWorkspaceAccess(lapsed, "import_media", duringOriginalTrial)).toMatchObject({
      allowed: false,
      state: "lapsed",
      reason: "subscription_ended_read_only",
    });
  });

  it("keeps existing work visible for a lapsed workspace", () => {
    const lapsed = {
      accessPlan: WorkspaceAccessPlan.TRIAL,
      ...dates,
      paidAt: new Date("2026-08-05T12:00:00Z"),
    };
    const at = new Date("2026-09-15T12:00:00Z");

    for (const action of ["read", "manage_billing", "manage_settings"] as const) {
      expect(decideWorkspaceAccess(lapsed, action, at)).toMatchObject({
        allowed: true,
        state: "lapsed",
      });
    }
    expect(decideWorkspaceAccess(lapsed, "publish_post", at).allowed).toBe(false);
  });

  it("restores full access when a lapsed workspace pays again", () => {
    const resubscribed = {
      accessPlan: WorkspaceAccessPlan.PAID,
      ...dates,
      paidAt: new Date("2026-08-05T12:00:00Z"),
    };

    expect(
      decideWorkspaceAccess(resubscribed, "import_media", new Date("2026-09-15T12:00:00Z")),
    ).toMatchObject({ allowed: true, state: "paid" });
  });
});
