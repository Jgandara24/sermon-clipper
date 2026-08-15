import { Prisma, PrismaClient, WorkspaceAccessPlan, WorkspaceRole } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideWorkspaceAccess } from "@/lib/billing/access";
import { handleStripeWebhookEvent } from "@/lib/billing/stripe";

const prisma = new PrismaClient();
const workspaceIdsToDelete: string[] = [];
const userEmailsToDelete: string[] = [];
const runId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

beforeAll(() => {
  process.env.STRIPE_PRICE_PAID = "price_paid";
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
      members: { create: { userId: user.id, role: WorkspaceRole.OWNER } },
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

function subscription(id: string, customer: string, status: string, price = "price_paid") {
  return {
    id,
    object: "subscription",
    customer,
    status,
    items: { data: [{ price: { id: price }, current_period_end: 1786046400 }] },
  };
}

describe("Stripe billing integration", () => {
  it("changes a Trial workspace to Paid after checkout", async () => {
    const workspace = await createWorkspace();
    const result = await handleStripeWebhookEvent(
      prisma,
      event(`evt_checkout_${runId}`, "checkout.session.completed", {
        id: "cs_test_1",
        object: "checkout.session",
        client_reference_id: workspace.id,
        customer: "cus_123",
        subscription: "sub_123",
        metadata: { workspaceId: workspace.id, planCode: "paid" },
      }),
    );

    expect(result).toEqual({ processed: true, duplicate: false });
    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.planCode).toBe("paid");
    expect(updated.accessPlan).toBe(WorkspaceAccessPlan.PAID);
    expect(updated.paidAt).not.toBeNull();
    expect(updated.stripeCustomerId).toBe("cus_123");
    expect(updated.stripeSubscriptionId).toBe("sub_123");
    expect(updated.stripePriceId).toBe("price_paid");
  });

  it("re-running checkout never regresses a later subscription state", async () => {
    // The event marker is written after the handler, so a failure in between leaves the event
    // retryable. Stripe backs off for minutes, which is long enough for a
    // customer.subscription.updated to land first. The retry must converge, not overwrite.
    const workspace = await createWorkspace();
    const checkout = event(`evt_checkout_replay_${runId}`, "checkout.session.completed", {
      id: "cs_test_replay",
      object: "checkout.session",
      client_reference_id: workspace.id,
      customer: "cus_replay",
      subscription: "sub_replay",
      metadata: { workspaceId: workspace.id, planCode: "paid" },
    });

    await handleStripeWebhookEvent(prisma, checkout);
    const first = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });

    // The subscription goes live before Stripe retries the checkout event.
    await handleStripeWebhookEvent(
      prisma,
      event(
        `evt_sub_replay_${runId}`,
        "customer.subscription.updated",
        subscription("sub_replay", "cus_replay", "active"),
      ),
    );

    // Stripe retries the checkout event. The dedup marker is keyed by event id, so force the
    // handler to run again the way a failed marker write would have left it.
    await prisma.stripeWebhookEvent.deleteMany({ where: { id: checkout.id } });
    await handleStripeWebhookEvent(prisma, checkout);

    const final = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(final.stripeSubscriptionStatus).toBe("active");
    expect(final.paidAt?.getTime()).toBe(first.paidAt?.getTime());
    expect(final.accessPlan).toBe(WorkspaceAccessPlan.PAID);
  });

  it("updates Paid state without granting product minutes", async () => {
    const workspace = await createWorkspace();
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { stripeCustomerId: "cus_456", stripeSubscriptionId: "sub_456" },
    });
    await handleStripeWebhookEvent(
      prisma,
      event(
        `evt_subscription_${runId}`,
        "customer.subscription.updated",
        subscription("sub_456", "cus_456", "active"),
      ),
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
    expect(updated.planCode).toBe("paid");
    expect(updated.accessPlan).toBe(WorkspaceAccessPlan.PAID);
    expect(updated.stripeSubscriptionStatus).toBe("active");
    expect(updated.minuteBalance.toString()).toBe("0");
    await expect(
      prisma.billingPeriodCredit.count({ where: { workspaceId: workspace.id } }),
    ).resolves.toBe(0);
  });

  it("returns a canceled subscription to Trial without deleting history", async () => {
    const workspace = await createWorkspace();
    const subId = `sub_del_${runId}`;
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        stripeCustomerId: `cus_del_${runId}`,
        stripeSubscriptionId: subId,
        planCode: "paid",
        accessPlan: WorkspaceAccessPlan.PAID,
      },
    });
    await handleStripeWebhookEvent(
      prisma,
      event(
        `evt_del_${runId}`,
        "customer.subscription.deleted",
        subscription(subId, `cus_del_${runId}`, "canceled"),
      ),
    );

    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.planCode).toBe("trial");
    expect(updated.accessPlan).toBe(WorkspaceAccessPlan.TRIAL);
    expect(updated.stripeSubscriptionStatus).toBe("canceled");

    // paidAt survives the cancellation, so access resolves as lapsed rather than resuming the
    // workspace's original 30-day trial window (which is still open for a fresh workspace).
    expect(updated.paidAt).not.toBeNull();
    expect(decideWorkspaceAccess(updated, "import_media")).toMatchObject({
      allowed: false,
      state: "lapsed",
    });
    expect(decideWorkspaceAccess(updated, "read").allowed).toBe(true);
  });

  it("ignores a late event for a superseded subscription", async () => {
    const workspace = await createWorkspace();
    const customerId = `cus_stale_${runId}`;
    const liveSubId = `sub_live_${runId}`;
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: liveSubId,
        planCode: "paid",
        accessPlan: WorkspaceAccessPlan.PAID,
      },
    });
    await handleStripeWebhookEvent(
      prisma,
      event(
        `evt_stale_${runId}`,
        "customer.subscription.deleted",
        subscription(`sub_old_${runId}`, customerId, "canceled"),
      ),
    );

    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.accessPlan).toBe(WorkspaceAccessPlan.PAID);
    expect(updated.stripeSubscriptionId).toBe(liveSubId);
    await expect(
      prisma.operationalEvent.count({
        where: { workspaceId: workspace.id, eventType: "stripe_subscription_event_ignored" },
      }),
    ).resolves.toBe(1);
  });

  it("adopts a pre-checkout Paid subscription by customer", async () => {
    const workspace = await createWorkspace();
    const customerId = `cus_adopt_${runId}`;
    const subId = `sub_adopt_${runId}`;
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { stripeCustomerId: customerId, stripeSubscriptionId: null },
    });
    await handleStripeWebhookEvent(
      prisma,
      event(
        `evt_adopt_${runId}`,
        "customer.subscription.created",
        subscription(subId, customerId, "active"),
      ),
    );

    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updated.stripeSubscriptionId).toBe(subId);
    expect(updated.accessPlan).toBe(WorkspaceAccessPlan.PAID);
  });

  it("records dunning without changing Paid access", async () => {
    const workspace = await createWorkspace();
    const subId = `sub_dun_${runId}`;
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: {
        stripeSubscriptionId: subId,
        planCode: "paid",
        accessPlan: WorkspaceAccessPlan.PAID,
      },
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
    expect(updated.accessPlan).toBe(WorkspaceAccessPlan.PAID);
    const events = await prisma.operationalEvent.findMany({
      where: { workspaceId: workspace.id, eventType: "stripe_invoice_payment_failed" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe("warning");
  });

  it("keeps a failed event retryable, processes the retry, then deduplicates", async () => {
    // A processing failure must not persist the dedupe marker: Stripe retries on a non-2xx
    // response, and a marked-but-unprocessed event would make the retry a silent no-op —
    // permanently losing, for example, a Paid activation.
    const workspaceId = crypto.randomUUID();
    const eventId = `evt_retryable_${runId}`;
    const failingThenOk = event(eventId, "checkout.session.completed", {
      id: `cs_retryable_${runId}`,
      object: "checkout.session",
      client_reference_id: workspaceId,
      customer: `cus_retryable_${runId}`,
      subscription: `sub_retryable_${runId}`,
      metadata: { workspaceId, planCode: "paid" },
    });

    // First delivery fails mid-processing (the workspace does not exist yet).
    await expect(handleStripeWebhookEvent(prisma, failingThenOk)).rejects.toThrow();
    await expect(
      prisma.stripeWebhookEvent.findUnique({ where: { id: eventId } }),
    ).resolves.toBeNull();

    // Recovery: the workspace exists when Stripe redelivers the same event id.
    const email = `stripe-retryable-${runId}@example.com`;
    userEmailsToDelete.push(email);
    const user = await prisma.user.create({ data: { email } });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        name: "Stripe Retry Church",
        ownerId: user.id,
        members: { create: { userId: user.id, role: WorkspaceRole.OWNER } },
      },
    });
    workspaceIdsToDelete.push(workspaceId);

    await expect(handleStripeWebhookEvent(prisma, failingThenOk)).resolves.toEqual({
      processed: true,
      duplicate: false,
    });
    const updated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(updated.accessPlan).toBe(WorkspaceAccessPlan.PAID);

    // A redelivery after successful processing stays a deduplicated no-op.
    await expect(handleStripeWebhookEvent(prisma, failingThenOk)).resolves.toEqual({
      processed: false,
      duplicate: true,
    });
  });
});
