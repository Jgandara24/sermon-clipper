import { Prisma } from "@prisma/client";
import { MAX_UPLOAD_BYTES } from "@/lib/limits";

export type PlanLimits = {
  code: string;
  name: string;
  includedMinutes: number;
  maxUploadBytes: number;
  maxVideoDurationS: number;
  overageAllowed: boolean;
};

const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    code: "free",
    name: "Free",
    includedMinutes: 60,
    maxUploadBytes: Math.min(MAX_UPLOAD_BYTES, 2 * 1024 * 1024 * 1024),
    maxVideoDurationS: 90 * 60,
    overageAllowed: false,
  },
  starter: {
    code: "starter",
    name: "Starter",
    includedMinutes: 300,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxVideoDurationS: 3 * 60 * 60,
    overageAllowed: false,
  },
  pro: {
    code: "pro",
    name: "Pro",
    includedMinutes: 1_200,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxVideoDurationS: 3 * 60 * 60,
    overageAllowed: false,
  },
  dev: {
    code: "dev",
    name: "Development",
    includedMinutes: 60,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxVideoDurationS: 3 * 60 * 60,
    overageAllowed: false,
  },
};

export function planForCode(planCode: string | null | undefined): PlanLimits {
  return PLAN_LIMITS[planCode ?? "free"] ?? PLAN_LIMITS.free;
}

export function estimateProcessingMinutes(durationS: number | Prisma.Decimal): Prisma.Decimal {
  const seconds = durationS instanceof Prisma.Decimal ? durationS.toNumber() : durationS;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return new Prisma.Decimal(1);
  }
  return new Prisma.Decimal(Math.max(1, Math.ceil(seconds / 60)));
}

export function formatBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  return `${Number.isInteger(gib) ? gib.toFixed(0) : gib.toFixed(1)} GB`;
}

