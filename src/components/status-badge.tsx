import { titleCaseStatus } from "@/lib/format";

const toneByStatus: Record<string, string> = {
  DRAFT: "border-amber-200 bg-amber-50 text-amber-800",
  QUEUED: "border-blue-200 bg-blue-50 text-blue-800",
  PROCESSING: "border-teal-200 bg-teal-50 text-teal-800",
  READY: "border-emerald-200 bg-emerald-50 text-emerald-800",
  FAILED: "border-red-200 bg-red-50 text-red-800",
  CANCELED: "border-stone-200 bg-stone-50 text-stone-700",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${
        toneByStatus[status] ?? "border-stone-200 bg-stone-50 text-stone-700"
      }`}
    >
      {titleCaseStatus(status)}
    </span>
  );
}
