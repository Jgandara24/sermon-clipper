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
  const events = await prisma.operationalEvent.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

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
