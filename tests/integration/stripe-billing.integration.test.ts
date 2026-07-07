import { Prisma, PrismaClient, WorkspaceRole } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleStripeWebhookEvent } from "@/lib/billing/stripe";

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
});
