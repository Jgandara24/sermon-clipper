import { constructStripeWebhookEvent, handleStripeWebhookEvent, StripeConfigurationError } from "@/lib/billing/stripe";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.text();

  try {
    const event = constructStripeWebhookEvent(body, request.headers.get("stripe-signature"));
    const result = await handleStripeWebhookEvent(prisma, event);
    return Response.json({ received: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Stripe webhook.";
    const status = error instanceof StripeConfigurationError ? 503 : 400;
    return Response.json({ error: { code: "STRIPE_WEBHOOK_INVALID", message } }, { status });
  }
}
