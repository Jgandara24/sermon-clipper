import { WorkspaceAccessPlan } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { decideWorkspaceAccess, trialDates } from "@/lib/billing/access";

const startedAt = new Date("2026-08-01T12:00:00Z");
const dates = trialDates(startedAt);

describe("workspace access", () => {
  it("gives Trial the same product actions as Paid before expiry", () => {
    const trial = { accessPlan: WorkspaceAccessPlan.TRIAL, ...dates };
    const paid = { accessPlan: WorkspaceAccessPlan.PAID, ...dates };
    const at = new Date("2026-08-15T12:00:00Z");

    for (const action of ["import_media", "start_processing", "export_clip", "publish_post"] as const) {
      expect(decideWorkspaceAccess(trial, action, at).allowed).toBe(true);
      expect(decideWorkspaceAccess(paid, action, at).allowed).toBe(true);
    }
  });

  it("makes an expired Trial read-only", () => {
    const trial = { accessPlan: WorkspaceAccessPlan.TRIAL, ...dates };
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
});
