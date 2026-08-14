import { describe, expect, it } from "vitest";
import { buildPlanGridReport, simulateMinuteLedger } from "@/lib/billing/plan-grid";

describe("billing plan grid", () => {
  it("shows that the free balance cannot fund the free maximum video", () => {
    const report = buildPlanGridReport();

    expect(report.plans.free).toMatchObject({
      includedMinutes: 60,
      maxVideoMinutes: 90,
      maximumVideoReservationMinutes: 90,
      canFundMaximumVideoFromOneGrant: false,
    });
  });

  it("measures weekly 70-minute, weekly 90-minute, and church profile demand", () => {
    const report = buildPlanGridReport();

    expect(report.usage.weekly70).toMatchObject({
      monthlySourceMinutes: 303.1,
      starterCovered: false,
      proCovered: true,
    });
    expect(report.usage.weekly90).toMatchObject({
      monthlySourceMinutes: 389.7,
      starterCovered: false,
      proCovered: true,
    });
    expect(report.usage.typical).toMatchObject({
      monthlySourceMinutes: 618,
      starterCovered: false,
      proCovered: true,
    });
    expect(report.usage.light.monthlySourceMinutes).toBe(358);
    expect(report.usage.heavy.monthlySourceMinutes).toBe(878);
  });

  it("accumulates unused grants across invoices without a monthly reset", () => {
    const result = simulateMinuteLedger([
      { kind: "grant", minutes: 300 },
      { kind: "reserve", minutes: 280 },
      { kind: "grant", minutes: 300 },
      { kind: "reserve", minutes: 280 },
    ]);

    expect(result).toMatchObject({ endingBalance: 40, hardBlockCount: 0 });
    expect(result.balances).toEqual([300, 20, 320, 40]);
    expect(buildPlanGridReport().codeFacts).toMatchObject({
      billingPeriodGrantMode: "additive_no_reset",
      starterWeekly70MonthlyDeficitMinutes: 3.1,
    });
  });

  it("hard-blocks a reservation that exceeds the current balance", () => {
    const result = simulateMinuteLedger([
      { kind: "grant", minutes: 60 },
      { kind: "reserve", minutes: 90 },
    ]);

    expect(result).toMatchObject({ endingBalance: 60, hardBlockCount: 1 });
    expect(result.balances).toEqual([60, 60]);
  });

  it("reports alternatives without selecting or changing an entitlement", () => {
    const report = buildPlanGridReport();

    expect(report.alternatives).toEqual(
      expect.arrayContaining([
        {
          conflict: "free_maximum_video",
          option: "increase_included_minutes",
          valueMinutes: 90,
        },
        {
          conflict: "free_maximum_video",
          option: "reduce_maximum_video_minutes",
          valueMinutes: 60,
        },
        {
          conflict: "starter_weekly_70",
          option: "increase_included_minutes",
          valueMinutes: 304,
        },
        {
          conflict: "starter_weekly_90",
          option: "increase_included_minutes",
          valueMinutes: 390,
        },
      ]),
    );
    expect(report.entitlementsChanged).toBe(false);
  });

  it("reports Stripe environment keys without inventing prices in code", () => {
    const report = buildPlanGridReport();

    expect(report.plans.free.stripePriceEnvVar).toBeNull();
    expect(report.plans.starter.stripePriceEnvVar).toBe("STRIPE_PRICE_STARTER");
    expect(report.plans.pro.stripePriceEnvVar).toBe("STRIPE_PRICE_PRO");
    expect(report.plans.starter).not.toHaveProperty("priceUsd");
  });

  it("exposes the declared but unused overage field", () => {
    const report = buildPlanGridReport();

    expect(report.codeFacts).toMatchObject({
      overageAllowedDeclared: true,
      overageAllowedValues: [false],
      overageAllowedRuntimeReads: 0,
    });
  });

  it("reports that upload presign checks only for a positive balance", () => {
    const report = buildPlanGridReport();

    expect(report.codeFacts).toMatchObject({
      uploadPresignBalanceGate: "greater_than_zero_only",
      durationReservationStage: "FINALIZE",
      lowBalanceUploadCanFailAfterTransfer: true,
    });
  });
});
