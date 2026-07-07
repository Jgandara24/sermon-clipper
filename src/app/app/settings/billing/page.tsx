import { formatDate, formatMinutes, titleCaseStatus } from "@/lib/format";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import { formatBytes, planForCode } from "@/lib/billing/plans";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "MANAGE_BILLING");
  const workspace = membership.workspace;
  const ledger = await prisma.usageLedger.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const plan = planForCode(workspace.planCode);

  return (
    <section className="grid gap-6">
      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Billing</p>
        <h1 className="mt-1 text-2xl font-semibold">Usage ledger</h1>
        <p className="mt-2 text-sm text-stone-500">
          Current plan limits and minute ledger for this workspace.
        </p>
        <div className="mt-5 grid gap-3 rounded-md bg-stone-50 p-4 sm:grid-cols-3">
          <div>
            <p className="text-sm text-stone-500">Plan</p>
            <p className="mt-1 text-2xl font-semibold text-stone-800">{plan.name}</p>
          </div>
          <div>
            <p className="text-sm text-stone-500">Included minutes</p>
            <p className="mt-1 text-2xl font-semibold text-stone-800">{plan.includedMinutes}</p>
          </div>
          <div>
            <p className="text-sm text-stone-500">Upload limit</p>
            <p className="mt-1 text-2xl font-semibold text-stone-800">{formatBytes(plan.maxUploadBytes)}</p>
          </div>
        </div>
        <div className="mt-3 rounded-md bg-stone-50 p-4">
          <p className="text-sm text-stone-500">Current minute balance</p>
          <p className="mt-1 text-3xl font-semibold text-teal-800">
            {formatMinutes(workspace.minuteBalance)}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Delta</th>
              <th className="px-4 py-3">Balance</th>
              <th className="px-4 py-3">Note</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((entry) => (
              <tr key={entry.id} className="border-t border-stone-100">
                <td className="px-4 py-3">{formatDate(entry.createdAt)}</td>
                <td className="px-4 py-3">{titleCaseStatus(entry.kind)}</td>
                <td className="px-4 py-3">{formatMinutes(entry.minutesDelta)}</td>
                <td className="px-4 py-3">{formatMinutes(entry.balanceAfter)}</td>
                <td className="px-4 py-3 text-stone-500">{entry.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {ledger.length === 0 ? (
          <p className="border-t border-stone-100 px-4 py-6 text-sm text-stone-500">
            No usage rows yet.
          </p>
        ) : null}
      </div>
    </section>
  );
}
