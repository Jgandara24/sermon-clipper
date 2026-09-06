import type { EditorialExceptionRow } from "@/lib/review/query";

/**
 * What went wrong on a service, and whether anybody has dealt with it.
 *
 * Open first, because an operator opens this page to find what still needs doing. Resolved rows
 * stay below rather than disappearing: an exception that was raised and closed is the record of a
 * decision, and P2.7's empty-pool path exists precisely so that record is never lost.
 */

function humanType(exceptionType: string) {
  return exceptionType.replace(/_/g, " ");
}

export function EditorialExceptionList({ rows }: { rows: EditorialExceptionRow[] }) {
  if (rows.length === 0) {
    return (
      <p data-testid="operator-exceptions-empty" className="text-sm text-stone-500">
        No exceptions have been raised against this service.
      </p>
    );
  }

  return (
    <ul data-testid="operator-exceptions" className="grid gap-2">
      {rows.map((row) => {
        const open = row.state === "OPEN";
        return (
          <li
            key={row.id}
            data-testid={`operator-exception-${row.state}`}
            className={`rounded-md border p-3 text-sm ${
              open ? "border-amber-200 bg-amber-50" : "border-stone-200 bg-white"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                  open
                    ? "border-amber-300 bg-amber-100 text-amber-900"
                    : "border-stone-200 bg-stone-50 text-stone-600"
                }`}
              >
                {open ? "Open" : "Resolved"}
              </span>
              <span className="text-xs font-medium uppercase tracking-wide text-stone-500">
                {humanType(row.exceptionType)}
              </span>
              <span className="text-xs text-stone-500">
                {new Date(row.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              </span>
            </div>
            <p className="mt-2 text-stone-700">{row.message}</p>
            {row.resolvedAt ? (
              <p className="mt-1 text-xs text-stone-500">
                Resolved{row.resolvedByEmail ? ` by ${row.resolvedByEmail}` : ""}
                {row.resolutionReason ? `: ${row.resolutionReason}` : ""}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
