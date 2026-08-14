import { Prisma } from "@prisma/client";
import { MAX_UPLOAD_BYTES } from "@/lib/limits";

export type PlanLimits = {
  code: "trial" | "paid";
  name: "Trial" | "Paid";
  includedMinutes: 0;
  maxUploadBytes: number;
  maxVideoDurationS: number;
  overageAllowed: true;
  stripePriceEnvVar?: "STRIPE_PRICE_PAID";
};

const SHARED_TECHNICAL_LIMITS = {
  includedMinutes: 0 as const,
  maxUploadBytes: MAX_UPLOAD_BYTES,
  maxVideoDurationS: 3 * 60 * 60,
  overageAllowed: true as const,
};

const PLAN_LIMITS: Record<"trial" | "paid", PlanLimits> = {
  trial: { code: "trial", name: "Trial", ...SHARED_TECHNICAL_LIMITS },
  paid: {
    code: "paid",
    name: "Paid",
    ...SHARED_TECHNICAL_LIMITS,
    stripePriceEnvVar: "STRIPE_PRICE_PAID",
  },
};

/** Legacy plan codes remain readable during migration, but the product exposes only Trial and Paid. */
export function planForCode(planCode: string | null | undefined): PlanLimits {
  return planCode === "starter" || planCode === "pro" || planCode === "dev" || planCode === "paid"
    ? PLAN_LIMITS.paid
    : PLAN_LIMITS.trial;
}

export function paidPlans(): PlanLimits[] {
  return [PLAN_LIMITS.paid];
}

export function stripePriceIdForPlan(
  planCode: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return planForCode(planCode).code === "paid" ? (env.STRIPE_PRICE_PAID ?? null) : null;
}

export function planForStripePriceId(
  priceId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PlanLimits | null {
  return priceId && env.STRIPE_PRICE_PAID === priceId ? PLAN_LIMITS.paid : null;
}

/** Kept as a usage measurement. It is not an entitlement or access gate. */
export function estimateProcessingMinutes(durationS: number | Prisma.Decimal): Prisma.Decimal {
  const seconds = durationS instanceof Prisma.Decimal ? durationS.toNumber() : durationS;
  if (!Number.isFinite(seconds) || seconds <= 0) return new Prisma.Decimal(1);
  return new Prisma.Decimal(Math.max(1, Math.ceil(seconds / 60)));
}

export function formatBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  return `${Number.isInteger(gib) ? gib.toFixed(0) : gib.toFixed(1)} GB`;
}
