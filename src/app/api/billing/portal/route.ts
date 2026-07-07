import { requireApiWorkspace } from "@/lib/api/auth";
import { apiError } from "@/lib/api/response";
import {
  createBillingPortalSession,
  StripeConfigurationError,
  StripePortalUnavailableError,
} from "@/lib/billing/stripe";

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await requireApiWorkspace("MANAGE_BILLING");
  if ("error" in auth) return auth.error;

  try {
    const session = await createBillingPortalSession(auth.workspace);
    return Response.redirect(session.url, 303);
  } catch (error) {
    if (error instanceof StripePortalUnavailableError) {
      return apiError("STRIPE_CUSTOMER_NOT_FOUND", "Start a paid subscription before opening the portal.", {
        status: 409,
      });
    }
    if (error instanceof StripeConfigurationError) {
      return apiError("STRIPE_NOT_CONFIGURED", error.message, { status: 503 });
    }
    throw error;
  }
}
