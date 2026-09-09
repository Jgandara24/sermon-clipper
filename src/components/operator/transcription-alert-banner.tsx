"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function TranscriptionAlertBanner() {
  const router = useRouter();
  const [count, setCount] = useState<number | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    async function check() {
      if (checking) return;
      checking = true;
      const requestController = new AbortController();
      const abortRequest = () => requestController.abort();
      controller.signal.addEventListener("abort", abortRequest, { once: true });
      const deadline = window.setTimeout(abortRequest, 15_000);
      try {
        const response = await fetch("/api/operator/transcription-alerts", {
          cache: "no-store",
          signal: requestController.signal,
        });
        // A lost session or revoked operator marker must clear the old account's count.
        if (response.status === 401 || response.status === 403) {
          setCount(null);
          setCheckFailed(false);
          return;
        }
        if (!response.ok) throw new Error("Alert check failed");
        const body = await response.json();
        if (!Number.isSafeInteger(body.data?.count) || body.data.count < 0) {
          throw new Error("Invalid alert count");
        }
        if (!controller.signal.aborted) {
          setCount(body.data.count);
          setCheckFailed(false);
        }
      } catch {
        // Keep the last known warning when a transient request fails.
        if (!controller.signal.aborted) setCheckFailed(true);
      } finally {
        window.clearTimeout(deadline);
        controller.signal.removeEventListener("abort", abortRequest);
        checking = false;
      }
    }
    void check();
    const interval = window.setInterval(() => void check(), 60_000);
    window.addEventListener("focus", check);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
    };
  }, []);

  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {(count !== null && count > 0) || checkFailed ? (
        <div data-testid="operator-transcription-alert" className="mx-5 mt-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 lg:mx-8">
          {count !== null && count > 0 ? (
            <p className="font-semibold">
              Backup transcription needs review: {count} {count === 1 ? "service" : "services"}.
            </p>
          ) : null}
          {checkFailed ? (
            <p>The app could not check for new transcription alerts. Open the review queue to check.</p>
          ) : null}
          <Link
            href="/app/operator/review#transcription-alerts"
            prefetch={false}
            onClick={(event) => {
              // A hash change alone would leave an already-open queue's alert list stale.
              if (window.location.pathname === "/app/operator/review" &&
                  !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                router.refresh();
                document.getElementById("transcription-alerts")?.scrollIntoView();
              }
            }}
            className="mt-1 inline-block font-medium underline"
          >
            View affected services
          </Link>
        </div>
      ) : null}
    </div>
  );
}
