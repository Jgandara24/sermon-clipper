import { getWorkspaceCostSummary } from "@/lib/cost/rollup";
import { formatDate, titleCaseStatus } from "@/lib/format";
import { requireCurrentUser, requirePrimaryWorkspacePermission } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function severityClass(severity: string) {
  if (severity === "error") return "bg-red-100 text-red-800";
  if (severity === "warning") return "bg-amber-100 text-amber-900";
  return "bg-stone-100 text-stone-700";
}

function formatMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Object.keys(metadata).length === 0) {
    return null;
  }
  return JSON.stringify(metadata, null, 2);
}

function MetadataDetails({ metadata }: { metadata: unknown }) {
  const formatted = formatMetadata(metadata);
  if (!formatted) return null;

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-teal-800">Metadata</summary>
      <pre className="mt-2 max-w-md overflow-auto rounded-md bg-stone-950 p-3 text-xs leading-relaxed text-stone-100">
        {formatted}
      </pre>
    </details>
  );
}

export default async function OperationsPage() {
  const user = await requireCurrentUser();
  const membership = await requirePrimaryWorkspacePermission(user.id, "MANAGE_OPERATIONS");
  const workspace = membership.workspace;
  const [events, cost] = await Promise.all([
    prisma.operationalEvent.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    getWorkspaceCostSummary(prisma, workspace.id),
  ]);

  return (
    <section className="grid gap-6">
      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Operations</p>
        <h1 className="mt-1 text-2xl font-semibold">Operational events</h1>
        <p className="mt-2 max-w-3xl text-sm text-stone-500">
          Recent upload, processing, export, approval, billing, and worker events for this
          workspace. Use this feed to diagnose failed jobs, skipped notifications, rejected
          uploads, and billing-limit stops.
        </p>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-teal-800">Processing cost</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500">Last {cost.windowDays} days</p>
            <p className="mt-1 text-2xl font-semibold">
              ${cost.knownCostUsd.toFixed(2)}
              {cost.unpricedEventCount > 0 ? <span className="text-sm text-amber-700">+</span> : null}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500">Cost facts</p>
            <p className="mt-1 text-2xl font-semibold">{cost.eventCount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500">Retry facts</p>
            <p className="mt-1 text-2xl font-semibold">{cost.retryCount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-stone-500">Unpriced facts</p>
            <p className="mt-1 text-2xl font-semibold">{cost.unpricedEventCount.toLocaleString()}</p>
          </div>
        </div>
        <p className="mt-3 text-xs text-stone-500">
          Durable daily totals from all processing stages. Provider invoices are the source of
          truth. A plus sign means one or more facts have no configured price, so the known total
          is a lower bound.
        </p>
        {cost.stages.length > 0 ? (
          <div className="mt-5 overflow-hidden rounded-md border border-stone-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="px-3 py-2">Stage</th>
                  <th className="px-3 py-2">Provider / model</th>
                  <th className="px-3 py-2">Facts</th>
                  <th className="px-3 py-2">Known cost</th>
                </tr>
              </thead>
              <tbody>
                {cost.stages.map((stage) => (
                  <tr key={`${stage.stage}:${stage.provider}:${stage.model ?? ""}`} className="border-t border-stone-100">
                    <td className="px-3 py-2">{titleCaseStatus(stage.stage)}</td>
                    <td className="px-3 py-2 text-stone-600">
                      {stage.provider}{stage.model ? ` / ${stage.model}` : ""}
                    </td>
                    <td className="px-3 py-2">
                      {stage.eventCount.toLocaleString()}
                      {stage.unpricedEventCount > 0 ? ` (${stage.unpricedEventCount} unpriced)` : ""}
                    </td>
                    <td className="px-3 py-2">${stage.knownCostUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-sm text-stone-500">No processing-cost rollups recorded yet.</p>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Event</th>
              <th className="px-4 py-3">Message</th>
              <th className="px-4 py-3">Refs</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id} className="border-t border-stone-100 align-top">
                <td className="whitespace-nowrap px-4 py-3 text-stone-500">{formatDate(event.createdAt)}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${severityClass(event.severity)}`}>
                    {event.severity}
                  </span>
                </td>
                <td className="px-4 py-3">{titleCaseStatus(event.category)}</td>
                <td className="px-4 py-3 font-medium">{titleCaseStatus(event.eventType)}</td>
                <td className="px-4 py-3 text-stone-700">
                  <p>{event.message}</p>
                  <MetadataDetails metadata={event.metadata} />
                </td>
                <td className="px-4 py-3 text-xs text-stone-500">
                  {event.projectId ? <p>project: {event.projectId}</p> : null}
                  {event.clipId ? <p>clip: {event.clipId}</p> : null}
                  {event.jobId ? <p>job: {event.jobId}</p> : null}
                  {event.exportJobId ? <p>export: {event.exportJobId}</p> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length === 0 ? (
          <p className="border-t border-stone-100 px-4 py-6 text-sm text-stone-500">
            No operational events recorded yet.
          </p>
        ) : null}
      </div>
    </section>
  );
}
