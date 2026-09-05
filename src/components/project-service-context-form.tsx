import { correctProjectServiceContextAction } from "@/app/actions/projects";

const OCCURRENCE_OPTIONS = [
  { value: "PRIMARY", label: "Main weekly service" },
  { value: "SECONDARY", label: "Second weekly service" },
  { value: "UNMATCHED", label: "Special service (not part of the weekly rhythm)" },
] as const;

/** `YYYY-MM-DD` for a date input, read in UTC because that is how the column stores it. */
function dateInputValue(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

/**
 * Corrects which service a project is from, when the schedule can still be re-derived.
 *
 * Rendered read-only once the project has durable work. The server action refuses that case too —
 * this only stops someone being offered a control that would be rejected.
 */
export function ProjectServiceContextForm({
  projectId,
  sermonDate,
  serviceOccurrence,
  locked,
}: {
  projectId: string;
  sermonDate: Date | null;
  serviceOccurrence: "PRIMARY" | "SECONDARY" | "UNMATCHED";
  locked: boolean;
}) {
  const current = OCCURRENCE_OPTIONS.find((o) => o.value === serviceOccurrence);

  if (locked) {
    return (
      <div className="rounded-md border border-stone-200 p-4">
        <h2 className="text-sm font-semibold">Service</h2>
        <p className="mt-2 text-sm text-stone-700">
          {sermonDate ? dateInputValue(sermonDate) : "No date recorded"} · {current?.label ?? serviceOccurrence}
        </p>
        <p className="mt-2 text-xs text-stone-500">
          This can no longer be changed: clips from this sermon have been posted, are posting, or
          were blocked, and moving the service would leave those records describing a day this
          project no longer claims. Upload the sermon again as a new project instead.
        </p>
      </div>
    );
  }

  return (
    <form action={correctProjectServiceContextAction} className="rounded-md border border-stone-200 p-4">
      <h2 className="text-sm font-semibold">Service</h2>
      <p className="mt-1 text-xs text-stone-500">
        Which service this sermon is from. It decides which days the clips post on, so correct it
        before the clips are scheduled.
      </p>
      <input type="hidden" name="projectId" value={projectId} />

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="sermon-date" className="text-sm font-medium">
            Service date
          </label>
          <input
            id="sermon-date"
            name="sermonDate"
            type="date"
            required
            defaultValue={dateInputValue(sermonDate)}
            className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
          />
        </div>
        <div>
          <label htmlFor="service-occurrence" className="text-sm font-medium">
            Which service
          </label>
          <select
            id="service-occurrence"
            name="serviceOccurrence"
            defaultValue={serviceOccurrence}
            className="mt-2 w-full rounded-md border border-stone-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
          >
            {OCCURRENCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <button
        type="submit"
        className="mt-3 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
      >
        Save service details
      </button>
    </form>
  );
}
