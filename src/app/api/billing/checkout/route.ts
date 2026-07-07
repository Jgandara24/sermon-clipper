import { z } from "zod";
import { requireApiWorkspace } from "@/lib/api/auth";
import { apiError } from "@/lib/api/response";
import {
  createBillingCheckoutSession,
  StripeConfigurationError,
  StripePlanConfigurationError,
} from "@/lib/billing/stripe";

export const dynamic = "force-dynamic";

const checkoutSchema = z.object({
  planCode: z.enum(["starter", "pro"]),
});

export async function POST(request: Request) {
  const auth = await requireApiWorkspace("MANAGE_BILLING");
  if ("error" in auth) return auth.error;

  const formData = await request.formData().catch(() => null);
  const parsed = checkoutSchema.safeParse({
    planCode: formData?.get("planCode"),
  });
  if (!parsed.success) {
    return apiError("INVALID_PLAN", "Choose a paid plan before starting checkout.");
  }

  try {
    const session = await createBillingCheckoutSession({
      workspace: auth.workspace,
      userEmail: auth.user.email,
      planCode: parsed.data.planCode,
    });
    if (!session.url) {
      return apiError("STRIPE_CHECKOUT_UNAVAILABLE", "Stripe did not return a checkout URL.", { status: 502 });
    }
    return Response.redirect(session.url, 303);
  } catch (error) {
    if (error instanceof StripeConfigurationError || error instanceof StripePlanConfigurationError) {
      return apiError("STRIPE_NOT_CONFIGURED", error.message, { status: 503 });
    }
    throw error;
  }
}
