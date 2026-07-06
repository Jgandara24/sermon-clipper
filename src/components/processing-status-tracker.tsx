"use client";

import { Clock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { titleCaseStatus } from "@/lib/format";

export type JobSummary = {
  id: string;
  type: string;
  state: string;
  errorCode: string | null;
  errorMessageUser: string | null;
};

type ProjectSnapshot = {
  status: string;
  processingJobs: JobSummary[];
};

const ACTIVE_PROJECT_STATUSES = new Set(["DRAFT", "QUEUED", "PROCESSING"]);
const ACTIVE_JOB_STATES = new Set(["QUEUED", "RUNNING", "WAITING", "RETRYING"]);
const POLL_INTERVAL_MS = 2000;

function describeJobState(job: JobSummary): string {
  if (job.errorMessageUser) return job.errorMessageUser;
  switch (job.state) {
    case "SUCCEEDED":
      return "Completed.";
    case "RUNNING":
      return "In progress…";
    case "CANCELED":
      return "Canceled.";
    default:
      return "Waiting for this stage.";
  }
}

export function ProcessingStatusTracker({
  projectId,
  initialStatus,
  initialJobs,
}: {
  projectId: string;
  initialStatus: string;
  initialJobs: JobSummary[];
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<ProjectSnapshot>({
    status: initialStatus,
    processingJobs: initialJobs,
  });
  const [isCanceling, setIsCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    if (!ACTIVE_PROJECT_STATUSES.has(snapshot.status)) {
      return;
    }

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const json = await res.json();
        if (!cancelled) {
          setSnapshot({ status: json.data.status, processingJobs: json.data.processingJobs });
        }
      } catch {
        // transient poll failure; the next tick will retry
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [projectId, snapshot.status]);

  async function handleCancel() {
    setIsCanceling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/cancel`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message ?? "Could not cancel this project.");
      }

      // The cancel response only confirms the project's new status; re-fetch to pick up the
      // now-CANCELED job rows too, instead of leaving the job list showing stale QUEUED/RUNNING.
      const refreshed = await fetch(`/api/projects/${projectId}`, { cache: "no-store" });
      if (refreshed.ok) {
        const refreshedJson = await refreshed.json();
        setSnapshot({ status: refreshedJson.data.status, processingJobs: refreshedJson.data.processingJobs });
      } else {
        setSnapshot((prev) => ({ ...prev, status: json.data.status }));
      }

      // Resyncs the server-rendered parts of the page (e.g. the header status badge), which
      // this client component's own state doesn't reach.
      router.refresh();
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : "Could not cancel this project.");
    } finally {
      setIsCanceling(false);
    }
  }

  const hasActiveJob = snapshot.processingJobs.some((job) => ACTIVE_JOB_STATES.has(job.state));
  const canCancel = ACTIVE_PROJECT_STATUSES.has(snapshot.status) && hasActiveJob;

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock size={18} aria-hidden="true" className="text-teal-800" />
          <h2 className="font-semibold">Processing stages</h2>
        </div>
        {canCancel ? (
          <button
            type="button"
            onClick={handleCancel}
            disabled={isCanceling}
            className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {isCanceling ? "Canceling…" : "Cancel"}
          </button>
        ) : null}
      </div>

      {cancelError ? (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
          {cancelError}
        </p>
      ) : null}

      <div className="mt-4 grid gap-3">
        {snapshot.processingJobs.map((job) => (
          <div
            key={job.id}
            className="flex items-center justify-between rounded-md border border-stone-200 px-3 py-2"
          >
            <div>
              <p className="text-sm font-medium">{titleCaseStatus(job.type)}</p>
              <p className="text-xs text-stone-500">{describeJobState(job)}
              </p>
            </div>
            <StatusBadge status={job.state} />
          </div>
        ))}
        {snapshot.processingJobs.length === 0 ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            No processing jobs yet — upload a video to start the pipeline.
          </p>
        ) : null}
      </div>
    </div>
  );
}
