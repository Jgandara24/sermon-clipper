import { formatDate } from "@/lib/format";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import { decideWorkspaceAccess } from "@/lib/billing/access";

export const dynamic = "force-dynamic";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "MANAGE_BILLING");
  const workspace = membership.workspace;
  const params = await searchParams;
  const access = decideWorkspaceAccess(workspace, "manage_billing");

  return (
    <section className="grid max-w-4xl gap-6">
      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Billing</p>
        <h1 className="mt-1 text-2xl font-semibold">Workspace access</h1>
        <p className="mt-2 text-sm text-stone-500">
          Trial and Paid have the same features. The trial lasts for 30 days.
        </p>
        {params.checkout === "success" ? (
          <div className="mt-5 rounded-md border border-teal-200 bg-teal-50 p-3 text-sm text-teal-900">
            Checkout is complete. Stripe will confirm Paid access.
          </div>
        ) : null}
        {params.checkout === "cancelled" ? (
          <div className="mt-5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            Checkout was canceled. Access did not change.
          </div>
        ) : null}
        <dl className="mt-5 grid gap-3 rounded-md bg-stone-50 p-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-stone-500">Plan</dt>
            <dd className="mt-1 text-2xl font-semibold text-stone-800">
              {access.state === "paid" ? "Paid" : "Trial"}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-stone-500">Trial started</dt>
            <dd className="mt-1 font-semibold text-stone-800">{formatDate(workspace.trialStartedAt)}</dd>
          </div>
          <div>
            <dt className="text-sm text-stone-500">Trial ends</dt>
            <dd className="mt-1 font-semibold text-stone-800">{formatDate(workspace.trialEndsAt)}</dd>
          </div>
        </dl>
        <p className="mt-4 text-sm text-stone-600">
          There are no published customer usage limits during the pilot. Technical safety limits and
          rate limits still apply.
        </p>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">Paid access</h2>
        <p className="mt-2 text-sm text-stone-500">
          Paid access keeps the workspace active after the trial. No card is required during the trial.
        </p>
        <p className="mt-3 text-sm text-stone-500">
          Stripe status: {workspace.stripeSubscriptionStatus ?? "not connected"}
        </p>
        {workspace.stripeCurrentPeriodEnd ? (
          <p className="mt-1 text-sm text-stone-500">
            Current period ends {formatDate(workspace.stripeCurrentPeriodEnd)}
          </p>
        ) : null}
        <div className="mt-5">
          {workspace.stripeCustomerId ? (
            <form action="/api/billing/portal" method="post">
              <button
                type="submit"
                className="rounded-md border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                Open customer portal
              </button>
            </form>
          ) : (
            <form action="/api/billing/checkout" method="post">
              <input type="hidden" name="planCode" value="paid" />
              <button
                type="submit"
                className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
              >
                Change to Paid
              </button>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
