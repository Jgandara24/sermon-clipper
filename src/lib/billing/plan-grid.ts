import { estimateProcessingMinutes, planForCode } from "./plans";

export type PlanGridReport = {
  plans: Record<
    "free" | "starter" | "pro",
    {
      includedMinutes: number;
      maxVideoMinutes: number;
      maximumVideoReservationMinutes: number;
      canFundMaximumVideoFromOneGrant: boolean;
      stripePriceEnvVar: string | null;
    }
  >;
  usage: Record<
    "weekly70" | "weekly90" | "light" | "typical" | "heavy",
    {
      monthlySourceMinutes: number;
      starterCovered: boolean;
      proCovered: boolean;
    }
  >;
  alternatives: Array<{
    conflict:
      | "free_maximum_video"
      | "starter_weekly_70"
      | "starter_weekly_90"
      | "starter_light_profile"
      | "starter_typical_profile"
      | "starter_heavy_profile";
    option: "increase_included_minutes" | "reduce_maximum_video_minutes";
    valueMinutes: number;
  }>;
  entitlementsChanged: false;
  codeFacts: {
    overageAllowedDeclared: true;
    overageAllowedValues: boolean[];
    overageAllowedRuntimeReads: 0;
    uploadPresignBalanceGate: "greater_than_zero_only";
    durationReservationStage: "FINALIZE";
    lowBalanceUploadCanFailAfterTransfer: true;
    billingPeriodGrantMode: "additive_no_reset";
    starterWeekly70MonthlyDeficitMinutes: number;
  };
};

const WEEKS_PER_MONTH = 4.33;

export type MinuteLedgerOperation = {
  kind: "grant" | "reserve";
  minutes: number;
};

/** Mirrors the additive grant and atomic non-negative reservation rules for report scenarios. */
export function simulateMinuteLedger(
  operations: MinuteLedgerOperation[],
  openingBalance = 0,
): { balances: number[]; endingBalance: number; hardBlockCount: number } {
  if (!Number.isFinite(openingBalance) || openingBalance < 0) {
    throw new Error("Opening minute balance must be non-negative.");
  }
  let balance = openingBalance;
  let hardBlockCount = 0;
  const balances: number[] = [];
  for (const operation of operations) {
    if (!Number.isFinite(operation.minutes) || operation.minutes <= 0) {
      throw new Error("Minute ledger operations must be positive.");
    }
    if (operation.kind === "grant") {
      balance += operation.minutes;
    } else if (balance >= operation.minutes) {
      balance -= operation.minutes;
    } else {
      hardBlockCount += 1;
    }
    balance = Math.round(balance * 100) / 100;
    balances.push(balance);
  }
  return { balances, endingBalance: balance, hardBlockCount };
}

function usageScenario(monthlySourceMinutes: number) {
  const rounded = Math.round(monthlySourceMinutes * 10) / 10;
  return {
    monthlySourceMinutes: rounded,
    starterCovered: planForCode("starter").includedMinutes >= rounded,
    proCovered: planForCode("pro").includedMinutes >= rounded,
  };
}

/** Builds a deterministic report from the current customer-entitlement constants. */
export function buildPlanGridReport(): PlanGridReport {
  const plans = Object.fromEntries(
    (["free", "starter", "pro"] as const).map((code) => {
      const plan = planForCode(code);
      const maximumVideoReservationMinutes = Number(
        estimateProcessingMinutes(plan.maxVideoDurationS),
      );
      return [
        code,
        {
          includedMinutes: plan.includedMinutes,
          maxVideoMinutes: plan.maxVideoDurationS / 60,
          maximumVideoReservationMinutes,
          canFundMaximumVideoFromOneGrant:
            plan.includedMinutes >= maximumVideoReservationMinutes,
          stripePriceEnvVar: plan.stripePriceEnvVar ?? null,
        },
      ];
    }),
  ) as PlanGridReport["plans"];

  return {
    plans,
    usage: {
      weekly70: usageScenario(70 * WEEKS_PER_MONTH),
      weekly90: usageScenario(90 * WEEKS_PER_MONTH),
      light: usageScenario(358),
      typical: usageScenario(618),
      heavy: usageScenario(878),
    },
    alternatives: [
      {
        conflict: "free_maximum_video",
        option: "increase_included_minutes",
        valueMinutes: plans.free.maximumVideoReservationMinutes,
      },
      {
        conflict: "free_maximum_video",
        option: "reduce_maximum_video_minutes",
        valueMinutes: plans.free.includedMinutes,
      },
      {
        conflict: "starter_weekly_70",
        option: "increase_included_minutes",
        valueMinutes: Math.ceil(70 * WEEKS_PER_MONTH),
      },
      {
        conflict: "starter_weekly_90",
        option: "increase_included_minutes",
        valueMinutes: Math.ceil(90 * WEEKS_PER_MONTH),
      },
      {
        conflict: "starter_light_profile",
        option: "increase_included_minutes",
        valueMinutes: 358,
      },
      {
        conflict: "starter_typical_profile",
        option: "increase_included_minutes",
        valueMinutes: 618,
      },
      {
        conflict: "starter_heavy_profile",
        option: "increase_included_minutes",
        valueMinutes: 878,
      },
    ],
    entitlementsChanged: false,
    codeFacts: {
      overageAllowedDeclared: true,
      overageAllowedValues: [
        ...new Set(
          (["free", "starter", "pro", "dev"] as const).map(
            (code) => planForCode(code).overageAllowed,
          ),
        ),
      ],
      overageAllowedRuntimeReads: 0,
      uploadPresignBalanceGate: "greater_than_zero_only",
      durationReservationStage: "FINALIZE",
      lowBalanceUploadCanFailAfterTransfer: true,
      billingPeriodGrantMode: "additive_no_reset",
      starterWeekly70MonthlyDeficitMinutes:
        Math.round((70 * WEEKS_PER_MONTH - plans.starter.includedMinutes) * 10) / 10,
    },
  };
}
