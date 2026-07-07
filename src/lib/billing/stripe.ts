import { Prisma, type PrismaClient, type Workspace } from "@prisma/client";
import Stripe from "stripe";
import { planForCode, planForStripePriceId, stripePriceIdForPlan } from "@/lib/billing/plans";
import { recordOperationalEventSafely } from "@/lib/observability/operational-events";
import { grantMinutesForBillingPeriod } from "@/lib/usage-ledger";

export const STRIPE_API_VERSION = "2026-02-25.clover";

export class StripeConfigurationError extends Error {}
export class StripePlanConfigurationError extends Error {}
export class StripePortalUnavailableError extends Error {}

type WorkspaceForBilling = Pick<
  Workspace,
  "id" | "name" | "stripeCustomerId" | "stripeSubscriptionId" | "planCode"
>;

export function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new StripeConfigurationError("STRIPE_SECRET_KEY is required.");
  }

  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION as never,
  });
}

function getAppUrl() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new StripeConfigurationError("NEXT_PUBLIC_APP_URL is required.");
  }
  return appUrl.replace(/\/$/, "");
}

function stringId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return null;
}

function timestampToDate(value: unknown): Date | null {
  return typeof value === "number" ? new Date(value * 1000) : null;
}

function firstSubscriptionPriceId(subscription: Stripe.Subscription): string | null {
  return subscription.items.data[0]?.price?.id ?? null;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const raw = invoice as unknown as {
    subscription?: unknown;
    parent?: { subscription_details?: { subscription?: unknown } };
    lines?: {
      data?: Array<{
        subscription?: unknown;
        parent?: { subscription_item_details?: { subscription?: unknown } };
      }>;
    };
  };

  return (
    stringId(raw.subscription) ??
    stringId(raw.parent?.subscription_details?.subscription) ??
    stringId(raw.lines?.data?.[0]?.subscription) ??
    stringId(raw.lines?.data?.[0]?.parent?.subscription_item_details?.subscription)
  );
}

function subscriptionStatusPlanCode(subscription: Stripe.Subscription): string {
  const pricePlan = planForStripePriceId(firstSubscriptionPriceId(subscription));
  if (!pricePlan) return "free";

  switch (subscription.status) {
    case "active":
    case "trialing":
    case "past_due":
      return pricePlan.code;
    default:
      return "free";
  }
}

export async function createBillingCheckoutSession(params: {
  workspace: WorkspaceForBilling;
  userEmail: string;
  planCode: string;
}) {
  const plan = planForCode(params.planCode);
  const priceId = stripePriceIdForPlan(plan.code);
  if (!priceId || !plan.stripePriceEnvVar) {
    throw new StripePlanConfigurationError(`${plan.name} is not configured for Stripe checkout.`);
  }

  const stripe = getStripeClient();
  const appUrl = getAppUrl();
  return stripe.checkout.sessions.create({
    mode: "subscription",
    client_reference_id: params.workspace.id,
    customer: params.workspace.stripeCustomerId ?? undefined,
    customer_email: params.workspace.stripeCustomerId ? undefined : params.userEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/app/settings/billing?checkout=success`,
    cancel_url: `${appUrl}/app/settings/billing?checkout=cancelled`,
    metadata: {
      workspaceId: params.workspace.id,
      planCode: plan.code,
    },
    subscription_data: {
      metadata: {
        workspaceId: params.workspace.id,
        planCode: plan.code,
      },
    },
  });
}

export async function createBillingPortalSession(workspace: WorkspaceForBilling) {
  if (!workspace.stripeCustomerId) {
    throw new StripePortalUnavailableError("Workspace does not have a Stripe customer yet.");
  }

  const stripe = getStripeClient();
  const appUrl = getAppUrl();
  return stripe.billingPortal.sessions.create({
    customer: workspace.stripeCustomerId,
    return_url: `${appUrl}/app/settings/billing`,
  });
}

export function constructStripeWebhookEvent(requestBody: string, signature: string | null) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new StripeConfigurationError("STRIPE_WEBHOOK_SECRET is required.");
  }
  if (!signature) {
    throw new Error("Stripe signature header is missing.");
  }

  return getStripeClient().webhooks.constructEvent(requestBody, signature, webhookSecret);
}

async function markEventReceived(client: PrismaClient, event: Stripe.Event): Promise<boolean> {
  try {
    await client.stripeWebhookEvent.create({ data: { id: event.id, type: event.type } });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}

async function handleCheckoutCompleted(client: PrismaClient, session: Stripe.Checkout.Session) {
  const workspaceId = session.metadata?.workspaceId ?? session.client_reference_id;
  if (!workspaceId) return;

  const plan = planForCode(session.metadata?.planCode);
  const subscriptionId = stringId(session.subscription);
  const customerId = stringId(session.customer);
  await client.workspace.update({
    where: { id: workspaceId },
    data: {
      planCode: plan.code,
      stripeCustomerId: customerId ?? undefined,
      stripeSubscriptionId: subscriptionId ?? undefined,
      stripeSubscriptionStatus: subscriptionId ? "checkout_completed" : undefined,
      stripePriceId: stripePriceIdForPlan(plan.code) ?? undefined,
    },
  });

  await recordOperationalEventSafely(client, {
    workspaceId,
    category: "billing",
    eventType: "stripe_checkout_completed",
    message: "Stripe checkout session completed.",
    metadata: {
      checkoutSessionId: session.id,
      customerId,
      subscriptionId,
      planCode: plan.code,
    },
  });
}

async function handleSubscriptionUpdated(client: PrismaClient, subscription: Stripe.Subscription) {
  const customerId = stringId(subscription.customer);
  const priceId = firstSubscriptionPriceId(subscription);
  const planCode = subscriptionStatusPlanCode(subscription);
  const currentPeriodEnd = timestampToDate(subscription.items.data[0]?.current_period_end);

  const workspace = await client.workspace.findFirst({
    where: {
      OR: [
        { stripeSubscriptionId: subscription.id },
        customerId ? { stripeCustomerId: customerId } : undefined,
      ].filter(Boolean) as Array<{ stripeSubscriptionId: string } | { stripeCustomerId: string }>,
    },
  });
  if (!workspace) return;

  await client.workspace.update({
    where: { id: workspace.id },
    data: {
      planCode,
      stripeCustomerId: customerId ?? workspace.stripeCustomerId,
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionStatus: subscription.status,
      stripePriceId: priceId,
      stripeCurrentPeriodEnd: currentPeriodEnd,
    },
  });

  await recordOperationalEventSafely(client, {
    workspaceId: workspace.id,
    category: "billing",
    eventType: "stripe_subscription_updated",
    severity: planCode === "free" ? "warning" : "info",
    message: "Stripe subscription state updated.",
    metadata: {
      subscriptionId: subscription.id,
      customerId,
      status: subscription.status,
      priceId,
      planCode,
      currentPeriodEnd: currentPeriodEnd?.toISOString() ?? null,
    },
  });
}

async function handleInvoicePaid(client: PrismaClient, invoice: Stripe.Invoice) {
  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) return;

  const workspace = await client.workspace.findUnique({ where: { stripeSubscriptionId: subscriptionId } });
  if (!workspace) return;

  const plan = planForCode(workspace.planCode);
  if (plan.code === "free" || plan.includedMinutes <= 0) return;

  await grantMinutesForBillingPeriod(client, {
    workspaceId: workspace.id,
    stripeInvoiceId: invoice.id,
    stripeSubscriptionId: subscriptionId,
    planCode: plan.code,
    minutes: plan.includedMinutes,
    note: `${plan.name} subscription included minutes for Stripe invoice ${invoice.id}.`,
  });
}

export async function handleStripeWebhookEvent(client: PrismaClient, event: Stripe.Event) {
  const shouldProcess = await markEventReceived(client, event);
  if (!shouldProcess) return { processed: false, duplicate: true };

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutCompleted(client, event.data.object as Stripe.Checkout.Session);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await handleSubscriptionUpdated(client, event.data.object as Stripe.Subscription);
      break;
    case "invoice.paid":
      await handleInvoicePaid(client, event.data.object as Stripe.Invoice);
      break;
    default:
      break;
  }

  return { processed: true, duplicate: false };
}
