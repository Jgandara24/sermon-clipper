import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  InvalidLedgerAmountError,
  computeReservationDelta,
  toDecimal,
} from "@/lib/usage-ledger";
import {
  estimateProcessingMinutes,
  planForCode,
  planForStripePriceId,
  stripePriceIdForPlan,
} from "@/lib/billing/plans";

describe("toDecimal", () => {
  it("passes Decimal values through unchanged", () => {
    const decimal = new Prisma.Decimal("12.50");
    expect(toDecimal(decimal)).toBe(decimal);
  });

  it("converts numbers and strings", () => {
    expect(toDecimal(5).toString()).toBe("5");
    expect(toDecimal("5.25").toString()).toBe("5.25");
  });
});

describe("computeReservationDelta", () => {
  it("negates a positive reservation amount", () => {
    expect(computeReservationDelta(10).toString()).toBe("-10");
  });

  it("rejects zero or negative amounts", () => {
    expect(() => computeReservationDelta(0)).toThrow(InvalidLedgerAmountError);
    expect(() => computeReservationDelta(-1)).toThrow(InvalidLedgerAmountError);
  });
});

describe("billing plans", () => {
  it("falls back to Trial for unknown plan codes", () => {
    expect(planForCode("unknown").code).toBe("trial");
  });

  it("ceil-estimates processing minutes from video duration", () => {
    expect(estimateProcessingMinutes(1).toString()).toBe("1");
    expect(estimateProcessingMinutes(60).toString()).toBe("1");
    expect(estimateProcessingMinutes(61).toString()).toBe("2");
  });

  it("maps paid app plans to configured Stripe prices", () => {
    const env = {
      NODE_ENV: "test",
      STRIPE_PRICE_PAID: "price_paid",
    } as NodeJS.ProcessEnv;

    expect(stripePriceIdForPlan("paid", env)).toBe("price_paid");
    expect(stripePriceIdForPlan("trial", env)).toBeNull();
    expect(planForStripePriceId("price_paid", env)?.code).toBe("paid");
    expect(planForStripePriceId("price_unknown", env)).toBeNull();
  });
});
