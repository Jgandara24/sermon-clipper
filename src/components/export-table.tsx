"use client";

import { Download, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { formatDate } from "@/lib/format";

type ExportRow = {
  id: string;
  clipTitle: string;
  filename: string;
  state: string;
  progress: number;
  errorMessageUser: string | null;
  createdAt: string;
  downloadUrl: string | null;
  linkExpired: boolean;
};

const ACTIVE_STATES = ["QUEUED", "RUNNING", "WAITING", "RETRYING"];
const POLL_MS = 3000;

function StateBadge({ state }: { state: string }) {
  const tone =
    state === "SUCCEEDED"
      ? "bg-emerald-100 text-emerald-800"
      : state === "FAILED"
        ? "bg-red-100 text-red-800"
        : "bg-stone-100 text-stone-600";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {ACTIVE_STATES.includes(state) ? <Loader2 size={10} className="animate-spin" aria-hidden="true" /> : null}
      {state.charAt(0) + state.slice(1).toLowerCase()}
    </span>
  );
}

function ExportRowActions({ row, onUpdate }: { row: ExportRow; onUpdate: (row: ExportRow) => void }) {
  async function handleRetry() {
    const res = await fetch(`/api/exports/${row.id}/retry`, { method: "POST" });
    if (res.ok) onUpdate({ ...row, state: "QUEUED", errorMessageUser: null });
  }

  async function handleResign() {
    const res = await fetch(`/api/exports/${row.id}/resign`, { method: "POST" });
    if (!res.ok) return;
    const json = await res.json();
    onUpdate({ ...row, downloadUrl: json.data.downloadUrl, linkExpired: false });
  }

  if (row.state === "FAILED") {
    return (
      <button
        type="button"
        onClick={handleRetry}
        className="inline-flex items-center gap-1 text-xs font-medium text-teal-800 hover:underline"
      >
        <RefreshCw size={12} aria-hidden="true" />
        Try again
      </button>
    );
  }
  if (row.linkExpired) {
    return (
      <button
        type="button"
        onClick={handleResign}
        className="inline-flex items-center gap-1 text-xs font-medium text-teal-800 hover:underline"
      >
        <RefreshCw size={12} aria-hidden="true" />
        Get new link
      </button>
    );
  }
  if (row.downloadUrl) {
    return (
      <a
        href={row.downloadUrl}
        className="inline-flex items-center gap-1 rounded-md border border-stone-300 px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50"
      >
        <Download size={12} aria-hidden="true" />
        Download
      </a>
    );
  }
  return null;
}

export function ExportTable({ initialExports }: { initialExports: ExportRow[] }) {
  const [rows, setRows] = useState(initialExports);

  useEffect(() => {
    const activeIds = rows.filter((row) => ACTIVE_STATES.includes(row.state)).map((row) => row.id);
    if (activeIds.length === 0) return;

    const interval = setInterval(async () => {
      const updates = await Promise.all(
        activeIds.map(async (id) => {
          const res = await fetch(`/api/exports/${id}`);
          if (!res.ok) return null;
          const json = await res.json();
          return json.data as {
            id: string;
            state: string;
            progress: number;
            errorMessageUser: string | null;
            downloadUrl: string | null;
            linkExpired: boolean;
          };
        }),
      );

      setRows((prev) =>
        prev.map((row) => {
          const update = updates.find((u) => u?.id === row.id);
          return update ? { ...row, ...update } : row;
        }),
      );
    }, POLL_MS);

    return () => clearInterval(interval);
  }, [rows]);

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        No exports yet — export a clip from its editor to see it here.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
          <tr>
            <th className="px-4 py-3 font-medium">Clip</th>
            <th className="px-4 py-3 font-medium">Filename</th>
            <th className="px-4 py-3 font-medium">Date</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="px-4 py-3 font-medium text-stone-800">{row.clipTitle}</td>
              <td className="px-4 py-3 text-stone-500">{row.filename}</td>
              <td className="px-4 py-3 text-stone-500">{formatDate(new Date(row.createdAt))}</td>
              <td className="px-4 py-3">
                <div className="grid gap-1">
                  <StateBadge state={row.state} />
                  {row.state === "FAILED" && row.errorMessageUser ? (
                    <span className="text-xs text-red-700">{row.errorMessageUser}</span>
                  ) : null}
                </div>
              </td>
              <td className="px-4 py-3">
                <ExportRowActions row={row} onUpdate={(next) => setRows((prev) => prev.map((r) => (r.id === next.id ? next : r)))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
