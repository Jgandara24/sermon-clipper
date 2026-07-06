"use client";

import { Download, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type ExportState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "WAITING" | "RETRYING" | "EXPIRED";

type ExportStatus = {
  id: string;
  state: ExportState;
  progress: number;
  errorMessageUser: string | null;
  downloadUrl: string | null;
  linkExpired: boolean;
};

const POLL_MS = 2000;
const ACTIVE_STATES: ExportState[] = ["QUEUED", "RUNNING", "WAITING", "RETRYING"];

function StatusLine({ status }: { status: ExportStatus }) {
  if (ACTIVE_STATES.includes(status.state)) {
    return (
      <p className="flex items-center gap-2 text-sm text-stone-600">
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        {status.state === "QUEUED" ? "Queued for export…" : "Rendering…"}
      </p>
    );
  }
  if (status.state === "SUCCEEDED" && status.downloadUrl) {
    return (
      <a
        href={status.downloadUrl}
        className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
      >
        <Download size={14} aria-hidden="true" />
        Download MP4
      </a>
    );
  }
  if (status.state === "FAILED") {
    return (
      <p className="text-sm text-red-700">
        {status.errorMessageUser ?? "Export failed on our side — your clip is safe."}
      </p>
    );
  }
  return null;
}

export function ExportPanel({ clipId }: { clipId: string }) {
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function pollJob(exportJobId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/exports/${exportJobId}`);
      if (!res.ok) return;
      const json = await res.json();
      setStatus(json.data);
      if (!ACTIVE_STATES.includes(json.data.state) && pollRef.current) {
        clearInterval(pollRef.current);
      }
    }, POLL_MS);
  }

  async function handleExport() {
    setIsStarting(true);
    try {
      const res = await fetch(`/api/clips/${clipId}/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) return;
      const json = await res.json();
      const exportJobId = json.data.exportJobId as string;
      setStatus({ id: exportJobId, state: "QUEUED", progress: 0, errorMessageUser: null, downloadUrl: null, linkExpired: false });
      pollJob(exportJobId);
    } finally {
      setIsStarting(false);
    }
  }

  async function handleRetry() {
    if (!status) return;
    const res = await fetch(`/api/exports/${status.id}/retry`, { method: "POST" });
    if (!res.ok) return;
    setStatus({ ...status, state: "QUEUED", errorMessageUser: null });
    pollJob(status.id);
  }

  return (
    <div className="grid gap-3 rounded-lg border border-stone-200 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-stone-800">Export</h2>
        {status?.state === "FAILED" ? (
          <button
            type="button"
            onClick={handleRetry}
            className="inline-flex items-center gap-1 text-xs font-medium text-teal-800 hover:underline"
          >
            <RefreshCw size={12} aria-hidden="true" />
            Try again
          </button>
        ) : null}
      </div>

      {!status ? (
        <button
          type="button"
          onClick={handleExport}
          disabled={isStarting}
          className="inline-flex w-fit items-center gap-2 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
        >
          <Download size={14} aria-hidden="true" />
          Export 9:16 MP4
        </button>
      ) : (
        <StatusLine status={status} />
      )}

      <p className="text-xs text-stone-500">
        Renders your current saved edit — crop, captions, and word cuts — into a downloadable MP4.
      </p>
    </div>
  );
}
