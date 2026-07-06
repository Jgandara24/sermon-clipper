import { LedgerKind, Prisma, type PrismaClient } from "@prisma/client";

export class InsufficientBalanceError extends Error {}
export class InvalidLedgerAmountError extends Error {}

export function toDecimal(value: number | string | Prisma.Decimal): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/** A reservation debit is always a positive amount of minutes turned into a negative ledger delta. */
export function computeReservationDelta(minutes: number | string | Prisma.Decimal): Prisma.Decimal {
  const amount = toDecimal(minutes);
  if (amount.lessThanOrEqualTo(0)) {
    throw new InvalidLedgerAmountError("Reservation amount must be greater than zero.");
  }
  return amount.negated();
}

type LedgerMutationParams = {
  workspaceId: string;
  kind: LedgerKind;
  minutesDelta: Prisma.Decimal;
  projectId?: string | null;
  jobId?: string | null;
  note?: string | null;
};

/**
 * Atomically adjusts a workspace's minute balance and writes the matching ledger row in one
 * transaction. The balance check happens inside the UPDATE itself (not a separate SELECT) so
 * concurrent reservations against the same workspace can't race past a zero balance.
 */
async function applyLedgerMutation(client: PrismaClient, params: LedgerMutationParams) {
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ minute_balance: Prisma.Decimal }[]>`
      UPDATE workspaces
      SET minute_balance = minute_balance + ${params.minutesDelta}, updated_at = now()
      WHERE id = ${params.workspaceId}::uuid
        AND minute_balance + ${params.minutesDelta} >= 0
      RETURNING minute_balance
    `;

    if (rows.length === 0) {
      throw new InsufficientBalanceError(
        `Workspace ${params.workspaceId} does not have enough minute balance for this operation.`,
      );
    }

    return tx.usageLedger.create({
      data: {
        workspaceId: params.workspaceId,
        kind: params.kind,
        projectId: params.projectId ?? undefined,
        jobId: params.jobId ?? undefined,
        minutesDelta: params.minutesDelta,
        balanceAfter: rows[0].minute_balance,
        note: params.note ?? undefined,
      },
    });
  });
}

/**
 * Reserves minutes against a job. Idempotent by jobId: calling this twice for the same job
 * (e.g. a retried request) returns the original reservation instead of double-charging.
 */
export async function reserveMinutesForJob(
  client: PrismaClient,
  params: {
    workspaceId: string;
    projectId: string;
    jobId: string;
    minutes: number | string | Prisma.Decimal;
    note?: string;
  },
) {
  const existing = await client.usageLedger.findFirst({
    where: { jobId: params.jobId, kind: LedgerKind.PROCESSING },
  });
  if (existing) {
    return existing;
  }

  return applyLedgerMutation(client, {
    workspaceId: params.workspaceId,
    kind: LedgerKind.PROCESSING,
    minutesDelta: computeReservationDelta(params.minutes),
    projectId: params.projectId,
    jobId: params.jobId,
    note: params.note ?? "Processing minutes reserved.",
  });
}

/**
 * Releases a job's reservation (cancel or failure). Idempotent: a job that was never reserved,
 * or already released, is a no-op rather than an error.
 */
export async function releaseReservationForJob(
  client: PrismaClient,
  params: { jobId: string; note?: string },
) {
  const reservation = await client.usageLedger.findFirst({
    where: { jobId: params.jobId, kind: LedgerKind.PROCESSING },
  });
  if (!reservation) {
    return null;
  }

  const alreadyReleased = await client.usageLedger.findFirst({
    where: { jobId: params.jobId, kind: LedgerKind.REFUND },
  });
  if (alreadyReleased) {
    return alreadyReleased;
  }

  return applyLedgerMutation(client, {
    workspaceId: reservation.workspaceId,
    kind: LedgerKind.REFUND,
    minutesDelta: reservation.minutesDelta.negated(),
    projectId: reservation.projectId,
    jobId: params.jobId,
    note: params.note ?? "Reserved minutes released.",
  });
}

/**
 * Settles a job's reservation on success. MVP: the reservation debit already stands as the
 * final charge, so settling is a lookup, not a new ledger row. A future phase that reserves an
 * estimate and charges actual usage would true up here with an ADJUSTMENT row.
 */
export async function settleReservationForJob(client: PrismaClient, jobId: string) {
  return client.usageLedger.findFirst({ where: { jobId, kind: LedgerKind.PROCESSING } });
}

export async function grantMinutes(
  client: PrismaClient,
  params: { workspaceId: string; minutes: number | string | Prisma.Decimal; note?: string },
) {
  const amount = toDecimal(params.minutes);
  if (amount.lessThanOrEqualTo(0)) {
    throw new InvalidLedgerAmountError("Grant amount must be greater than zero.");
  }

  return applyLedgerMutation(client, {
    workspaceId: params.workspaceId,
    kind: LedgerKind.GRANT,
    minutesDelta: amount,
    note: params.note ?? "Minutes granted.",
  });
}
