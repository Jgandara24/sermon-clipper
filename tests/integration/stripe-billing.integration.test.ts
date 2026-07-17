import { Prisma, PrismaClient, WorkspaceRole } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleStripeWebhookEvent } from "@/lib/billing/stripe";
import { revokeMinutesForRefundedInvoice } from "@/lib/usage-ledger";

const prisma = new PrismaClient();
const workspaceIdsToDelete: string[] = [];
const userEmailsToDelete: string[] = [];
const runId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

beforeAll(() => {
  process.env.STRIPE_PRICE_STARTER = "price_starter";
  process.env.STRIPE_PRICE_PRO = "price_pro";
});

afterAll(async () => {
  if (workspaceIdsToDelete.length > 0) {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIdsToDelete } } });
  }
  if (userEmailsToDelete.length > 0) {
    await prisma.user.deleteMany({ where: { email: { in: userEmailsToDelete } } });
  }
  await prisma.$disconnect();
});

async function createWorkspace() {
  const email = `stripe-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  userEmailsToDelete.push(email);
  const user = await prisma.user.create({ data: { email } });
  const workspace = await prisma.workspace.create({
    data: {
      name: "Stripe Church",
      ownerId: user.id,
      minuteBalance: new Prisma.Decimal("0"),
      members: {
        create: {
          userId: user.id,
          role: WorkspaceRole.OWNER,
        },
      },
    },
  });
  workspaceIdsToDelete.push(workspace.id);
  return workspace;
}

function event<T>(id: string, type: string, object: T): Stripe.Event {
  return {
    id,
    type,
    object: "event",
    api_version: "2026-02-25.clover",
    created: 1783454400,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    data: { object },
  } as unknown as Stripe.Event;
}

describe("Stripe billing integration", () => {
  it("records checkout completion against a workspace", async () => {
    const workspace = await createWorkspace();

    const result = await handleStripeWebhookEvent(
      prisma,
      event(`evt_checkout_${runId}`, "checkout.session.completed", {
        id: "cs_test_1",
        object: "checkout.session",
        client_reference_id: workspace.id,
        customer: "cus_123",
        subscription: "sub_123",
        metadata: { workspaceId: workspace.id, planCode: "starter" },
      }),
    );

    expect(result).toEqual({ processed: true, duplicate: false });
    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.planCode).toBe("starter");
    expect(updated.stripeCustomerId).toBe("cus_123");
    expect(updated.stripeSubscriptionId).toBe("sub_123");
    expect(updated.stripePriceId).toBe("price_starter");
  });

  it("updates subscription state and grants paid invoice minutes idempotently", async () => {
    const workspace = await createWorkspace();
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { stripeCustomerId: "cus_456", stripeSubscriptionId: "sub_456" },
    });

    await handleStripeWebhookEvent(
      prisma,
      event(`evt_subscription_${runId}`, "customer.subscription.updated", {
        id: "sub_456",
        object: "subscription",
        customer: "cus_456",
        status: "active",
        items: {
          data: [
            {
              price: { id: "price_pro" },
              current_period_end: 1786046400,
            },
          ],
        },
      }),
    );

    await handleStripeWebhookEvent(
      prisma,
      event(`evt_invoice_${runId}`, "invoice.paid", {
        id: "in_456",
        object: "invoice",
        subscription: "sub_456",
      }),
    );
    await handleStripeWebhookEvent(
      prisma,
      event(`evt_invoice_${runId}`, "invoice.paid", {
        id: "in_456",
        object: "invoice",
        subscription: "sub_456",
      }),
    );

    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.planCode).toBe("pro");
    expect(updated.stripeSubscriptionStatus).toBe("active");
    expect(updated.stripePriceId).toBe("price_pro");
    expect(updated.minuteBalance.toString()).toBe("1200");

    const credits = await prisma.billingPeriodCredit.findMany({ where: { workspaceId: workspace.id } });
    expect(credits).toHaveLength(1);
    expect(credits[0].stripeInvoiceId).toBe("in_456");
  });

  it("downgrades to free on subscription.deleted without destroying balance or ledger history", async () => {
    const workspace = await createWorkspace();
    const subId = `sub_del_${runId}`;
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { stripeCustomerId: `cus_del_${runId}`, stripeSubscriptionId: subId, planCode: "pro" },
    });
    await handleStripeWebhookEvent(
      prisma,
      event(`evt_del_grant_${runId}`, "invoice.paid", {
        id: `in_del_${runId}`,
        object: "invoice",
        subscription: subId,
      }),
    );

    await handleStripeWebhookEvent(
      prisma,
      event(`evt_del_${runId}`, "customer.subscription.deleted", {
        id: subId,
        object: "subscription",
        customer: `cus_del_${runId}`,
        status: "canceled",
        items: { data: [{ price: { id: "price_pro" }, current_period_end: 1786046400 }] },
      }),
    );

    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.planCode).toBe("free");
    expect(updated.stripeSubscriptionStatus).toBe("canceled");
    // Cancellation does not confiscate already-granted minutes or erase billing history.
    expect(updated.minuteBalance.toString()).toBe("1200");
    const ledger = await prisma.usageLedger.findMany({ where: { workspaceId: workspace.id } });
    expect(ledger.length).toBeGreaterThanOrEqual(1);
  });

  it("records a dunning warning on invoice.payment_failed without touching plan state", async () => {
    const workspace = await createWorkspace();
    const subId = `sub_dun_${runId}`;
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { stripeSubscriptionId: subId, planCode: "starter" },
    });

    await handleStripeWebhookEvent(
      prisma,
      event(`evt_dun_${runId}`, "invoice.payment_failed", {
        id: `in_dun_${runId}`,
        object: "invoice",
        subscription: subId,
        attempt_count: 2,
      }),
    );

    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.planCode).toBe("starter");
    const events = await prisma.operationalEvent.findMany({
      where: { workspaceId: workspace.id, eventType: "stripe_invoice_payment_failed" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("warning");
  });

  it("claws back granted minutes on a full refund, floored so the balance never goes negative", async () => {
    const workspace = await createWorkspace();
    const subId = `sub_ref_${runId}`;
    const invoiceId = `in_ref_${runId}`;
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { stripeSubscriptionId: subId, planCode: "pro" },
    });
    await handleStripeWebhookEvent(
      prisma,
      event(`evt_ref_grant_${runId}`, "invoice.paid", {
        id: invoiceId,
        object: "invoice",
        subscription: subId,
      }),
    );
    // Simulate the church having spent most of the granted minutes before refunding.
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { minuteBalance: new Prisma.Decimal("100") },
    });

    await handleStripeWebhookEvent(
      prisma,
      event(`evt_ref_${runId}`, "charge.refunded", {
        id: `ch_ref_${runId}`,
        object: "charge",
        invoice: invoiceId,
        refunded: true,
        amount_refunded: 2900,
      }),
    );

    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    // Granted 1200 but only 100 remained — clawback floors at the balance, never negative.
    expect(updated.minuteBalance.toString()).toBe("0");
    const refundRows = await prisma.usageLedger.findMany({
      where: { workspaceId: workspace.id, kind: "REFUND" },
    });
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0].minutesDelta.toString()).toBe("-100");

    // A second refund event for the same invoice must not double-claw.
    await handleStripeWebhookEvent(
      prisma,
      event(`evt_ref_dup_${runId}`, "charge.refunded", {
        id: `ch_ref_dup_${runId}`,
        object: "charge",
        invoice: invoiceId,
        refunded: true,
        amount_refunded: 2900,
      }),
    );
    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(after.minuteBalance.toString()).toBe("0");
    await expect(
      prisma.usageLedger.count({ where: { workspaceId: workspace.id, kind: "REFUND" } }),
    ).resolves.toBe(1);
  });

  it("claws back exactly once when two refund events race for the same invoice", async () => {
    const workspace = await createWorkspace();
    const subId = `sub_race_${runId}`;
    const invoiceId = `in_race_${runId}`;
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { stripeSubscriptionId: subId, planCode: "pro" },
    });
    await handleStripeWebhookEvent(
      prisma,
      event(`evt_race_grant_${runId}`, "invoice.paid", {
        id: invoiceId,
        object: "invoice",
        subscription: subId,
      }),
    );
    // Extra headroom so a double-claw would be visible in the balance, not masked by the floor.
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { minuteBalance: new Prisma.Decimal("3000") },
    });

    // Two concurrent clawbacks on separate pooled connections (distinct Stripe events for the
    // same invoice — webhook event dedupe does not protect this path). The workspace row lock
    // must serialize them and the post-lock idempotency check must make the loser a no-op.
    const results = await Promise.all([
      revokeMinutesForRefundedInvoice(prisma, { stripeInvoiceId: invoiceId }),
      revokeMinutesForRefundedInvoice(prisma, { stripeInvoiceId: invoiceId }),
    ]);

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(after.minuteBalance.toString()).toBe("1800"); // 3000 - 1200, exactly once
    await expect(
      prisma.usageLedger.count({ where: { workspaceId: workspace.id, kind: "REFUND" } }),
    ).resolves.toBe(1);
    // Both callers resolve to the same ledger row.
    expect(results[0].ledger?.id).toBe(results[1].ledger?.id);
  });

  it("records but does not claw back on a partial refund", async () => {
    const workspace = await createWorkspace();
    const subId = `sub_part_${runId}`;
    const invoiceId = `in_part_${runId}`;
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { stripeSubscriptionId: subId, planCode: "starter" },
    });
    await handleStripeWebhookEvent(
      prisma,
      event(`evt_part_grant_${runId}`, "invoice.paid", {
        id: invoiceId,
        object: "invoice",
        subscription: subId,
      }),
    );
    const granted = (await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } }))
      .minuteBalance;

    await handleStripeWebhookEvent(
      prisma,
      event(`evt_part_${runId}`, "charge.refunded", {
        id: `ch_part_${runId}`,
        object: "charge",
        invoice: invoiceId,
        refunded: false,
        amount_refunded: 500,
      }),
    );

    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.minuteBalance.toString()).toBe(granted.toString());
    await expect(
      prisma.usageLedger.count({ where: { workspaceId: workspace.id, kind: "REFUND" } }),
    ).resolves.toBe(0);
    const events = await prisma.operationalEvent.findMany({
      where: { workspaceId: workspace.id, eventType: "stripe_charge_partially_refunded" },
    });
    expect(events).toHaveLength(1);
  });
});
