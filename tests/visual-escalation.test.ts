import { expect, it } from "vitest";
import { visualEscalationCostMicroUsd } from "@/lib/media/visual-escalation";

it("rounds the combined token quote upward without losing integer precision", () => {
  expect(visualEscalationCostMicroUsd(1, 1, { inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1 })).toBe(BigInt(1));
  expect(visualEscalationCostMicroUsd(100, 20, { inputMicroUsdPerMillionTokens: 1000000, outputMicroUsdPerMillionTokens: 2000000 })).toBe(BigInt(140));
  const maximum = Number.MAX_SAFE_INTEGER;
  expect(visualEscalationCostMicroUsd(maximum, maximum, { inputMicroUsdPerMillionTokens: maximum, outputMicroUsdPerMillionTokens: maximum }))
    .toBe((BigInt(maximum) * BigInt(maximum) * BigInt(2) + BigInt(999999)) / BigInt(1000000));
});
it("rejects negative, fractional, and unsafe token quantities before any reservation", () => {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    expect(() => visualEscalationCostMicroUsd(value, 1, { inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1 })).toThrow();
  }
});
