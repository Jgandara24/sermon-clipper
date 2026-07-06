import { formatDate, formatMinutes, titleCaseStatus } from "@/lib/format";
import { requireCurrentUser, requirePrimaryWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await requireCurrentUser();
  const workspace = await requirePrimaryWorkspace(user.id);
  const ledger = await prisma.usageLedger.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return (
    <section className="grid gap-6">
      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Billing</p>
        <h1 className="mt-1 text-2xl font-semibold">Usage ledger</h1>
        <p className="mt-2 text-sm text-stone-500">
          Stripe and real usage charging are intentionally not wired in Phase 1.
        </p>
        <div className="mt-5 rounded-md bg-stone-50 p-4">
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
