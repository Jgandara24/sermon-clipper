import { LedgerKind, Prisma, type PrismaClient } from "@prisma/client";
import { recordOperationalEvent } from "@/lib/observability/operational-events";

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

    const ledger = await tx.usageLedger.create({
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
    await recordOperationalEvent(tx, {
      workspaceId: params.workspaceId,
      category: "billing",
      eventType: `ledger_${params.kind.toLowerCase()}`,
      severity: params.kind === LedgerKind.REFUND ? "info" : "info",
      message: `Usage ledger ${params.kind.toLowerCase()} recorded.`,
      projectId: params.projectId ?? null,
      jobId: params.jobId ?? null,
      metadata: {
        ledgerId: ledger.id,
        minutesDelta: params.minutesDelta.toString(),
        balanceAfter: ledger.balanceAfter.toString(),
        note: params.note ?? null,
      },
    });
    return ledger;
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

export async function releaseReservationsForProject(
  client: PrismaClient,
  params: { projectId: string; note?: string },
) {
  const reservations = await client.usageLedger.findMany({
    where: { projectId: params.projectId, kind: LedgerKind.PROCESSING },
  });

  const released = [];
  for (const reservation of reservations) {
    if (!reservation.jobId) continue;
    const refund = await releaseReservationForJob(client, {
      jobId: reservation.jobId,
      note: params.note ?? "Reserved minutes released.",
    });
    if (refund) released.push(refund);
  }

  return released;
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

export async function grantMinutesForBillingPeriod(
  client: PrismaClient,
  params: {
    workspaceId: string;
    stripeInvoiceId: string;
    stripeSubscriptionId: string;
    planCode: string;
    minutes: number | string | Prisma.Decimal;
    note?: string;
  },
) {
  const amount = toDecimal(params.minutes);
  if (amount.lessThanOrEqualTo(0)) {
    throw new InvalidLedgerAmountError("Grant amount must be greater than zero.");
  }

  return client.$transaction(async (tx) => {
    const existing = await tx.billingPeriodCredit.findUnique({
      where: { stripeInvoiceId: params.stripeInvoiceId },
      include: { ledger: true },
    });
    if (existing?.ledger) return existing.ledger;

    const rows = await tx.$queryRaw<{ minute_balance: Prisma.Decimal }[]>`
      UPDATE workspaces
      SET minute_balance = minute_balance + ${amount}, updated_at = now()
      WHERE id = ${params.workspaceId}::uuid
      RETURNING minute_balance
    `;

    if (rows.length === 0) {
      throw new Error(`Workspace ${params.workspaceId} was not found for billing credit.`);
    }

    const ledger = await tx.usageLedger.create({
      data: {
        workspaceId: params.workspaceId,
        kind: LedgerKind.GRANT,
        minutesDelta: amount,
        balanceAfter: rows[0].minute_balance,
        note: params.note ?? `Stripe invoice ${params.stripeInvoiceId} included minutes.`,
      },
    });

    await tx.billingPeriodCredit.create({
      data: {
        workspaceId: params.workspaceId,
        stripeInvoiceId: params.stripeInvoiceId,
        stripeSubscriptionId: params.stripeSubscriptionId,
        planCode: params.planCode,
        minutesGranted: amount,
        ledgerId: ledger.id,
      },
    });

    await recordOperationalEvent(tx, {
      workspaceId: params.workspaceId,
      category: "billing",
      eventType: "stripe_minutes_granted",
      message: "Stripe billing period minutes granted.",
      metadata: {
        ledgerId: ledger.id,
        stripeInvoiceId: params.stripeInvoiceId,
        stripeSubscriptionId: params.stripeSubscriptionId,
        planCode: params.planCode,
        minutesGranted: amount.toString(),
        balanceAfter: ledger.balanceAfter.toString(),
      },
    });

    return ledger;
  });
}

/**
 * Claws back the minutes granted for a refunded Stripe invoice. The clawback is floored at the
 * workspace's current balance — already-spent minutes are not re-collected and the balance never
 * goes negative. Idempotent per invoice: the REFUND ledger row carries a marker note that
 * short-circuits repeat calls (webhook event dedupe is the primary guard; this also protects
 * against distinct Stripe events referencing the same invoice).
 */
export async function revokeMinutesForRefundedInvoice(
  client: PrismaClient,
  params: { stripeInvoiceId: string; note?: string },
) {
  const marker = `[refund:invoice:${params.stripeInvoiceId}]`;

  return client.$transaction(async (tx) => {
    const credit = await tx.billingPeriodCredit.findUnique({
      where: { stripeInvoiceId: params.stripeInvoiceId },
    });
    if (!credit) {
      return { ledger: null, revokedMinutes: new Prisma.Decimal(0), workspaceId: null };
    }

    const existing = await tx.usageLedger.findFirst({
      where: { workspaceId: credit.workspaceId, kind: LedgerKind.REFUND, note: { contains: marker } },
    });
    if (existing) {
      return {
        ledger: existing,
        revokedMinutes: existing.minutesDelta.negated(),
        workspaceId: credit.workspaceId,
      };
    }

    // Row-lock the workspace so the floor computation can't race a concurrent reservation.
    const rows = await tx.$queryRaw<{ minute_balance: Prisma.Decimal }[]>`
      SELECT minute_balance FROM workspaces WHERE id = ${credit.workspaceId}::uuid FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new Error(`Workspace ${credit.workspaceId} was not found for refund clawback.`);
    }

    const balance = toDecimal(rows[0].minute_balance);
    const clawback = Prisma.Decimal.min(balance, toDecimal(credit.minutesGranted));
    const updated = await tx.$queryRaw<{ minute_balance: Prisma.Decimal }[]>`
      UPDATE workspaces
      SET minute_balance = minute_balance - ${clawback}, updated_at = now()
      WHERE id = ${credit.workspaceId}::uuid
      RETURNING minute_balance
    `;

    // A zero-delta row still gets written: it is the audit record and the idempotency marker.
    const ledger = await tx.usageLedger.create({
      data: {
        workspaceId: credit.workspaceId,
        kind: LedgerKind.REFUND,
        minutesDelta: clawback.negated(),
        balanceAfter: updated[0].minute_balance,
        note: `${params.note ?? "Stripe refund clawback."} ${marker}`,
      },
    });

    await recordOperationalEvent(tx, {
      workspaceId: credit.workspaceId,
      category: "billing",
      eventType: "stripe_refund_minutes_revoked",
      severity: "warning",
      message: "Minutes revoked after a Stripe refund.",
      metadata: {
        ledgerId: ledger.id,
        stripeInvoiceId: params.stripeInvoiceId,
        minutesGranted: credit.minutesGranted.toString(),
        minutesRevoked: clawback.toString(),
        balanceAfter: ledger.balanceAfter.toString(),
      },
    });

    return { ledger, revokedMinutes: clawback, workspaceId: credit.workspaceId };
  });
}
