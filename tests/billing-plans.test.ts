import { describe, expect, it } from "vitest";
import { paidPlans, planForCode, stripePriceIdForPlan } from "@/lib/billing/plans";

describe("billing plans", () => {
  it("exposes only Trial and Paid", () => {
    expect(planForCode("trial").name).toBe("Trial");
    expect(paidPlans().map((plan) => plan.code)).toEqual(["paid"]);
  });

  it("gives Trial and Paid the same capabilities", () => {
    const trial = planForCode("trial");
    const paid = planForCode("paid");

    expect(trial.maxUploadBytes).toBe(paid.maxUploadBytes);
    expect(trial.maxVideoDurationS).toBe(paid.maxVideoDurationS);
    expect(trial.includedMinutes).toBe(0);
    expect(paid.includedMinutes).toBe(0);
  });

  it("maps old paid codes to Paid during migration", () => {
    expect(planForCode("starter").code).toBe("paid");
    expect(planForCode("pro").code).toBe("paid");
    expect(planForCode("free").code).toBe("trial");
  });

  it("uses one Stripe price", () => {
    const env = { NODE_ENV: "test", STRIPE_PRICE_PAID: "price_paid" } as NodeJS.ProcessEnv;
    expect(stripePriceIdForPlan("paid", env)).toBe("price_paid");
    expect(stripePriceIdForPlan("trial", env)).toBeNull();
  });
});
