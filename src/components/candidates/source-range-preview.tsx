"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Playing one candidate's moment straight from the sermon recording.
 *
 * **Nothing is rendered to make this work.** No `ExportJob`, no MP4, no derivative. The browser
 * asks the byte-range media route for the part of the recording this candidate covers, and stops
 * at the end of it. A reserve that nobody schedules therefore costs nothing but the bytes someone
 * chose to watch, which is the whole derivative-first argument: a final render is for a clip
 * that is going out, not for a clip somebody is thinking about.
 *
 * **`preload="none"` is load-bearing, not a nicety.** A service holds a dozen candidates. With
 * `metadata` or `auto`, opening the page would fetch a dozen range requests against a sermon
 * recording before anyone pressed anything. The element is also only mounted while open, so a
 * closed preview has no `src` for a browser to be clever about.
 *
 * **One continuous range, and no skipping inside it.** The clip is one span of the recording
 * (Rev2: every deliverable edit is one continuous source range), so the only seeking here is the
 * single jump to the start. There is deliberately no logic that hops over anything in the middle —
 * a preview that skipped would show a cut that the final render would not.
 *
 * P4 swaps the URL for the shared uncropped 480p proxy. Nothing in this contract changes: it takes
 * a URL and two offsets and knows nothing about what is behind them.
 */

export type SourceRangePreviewProps = {
  /**
   * The signed recording, or null when there is nothing to play.
   *
   * Null is how a purged source arrives. The caller does not sign a URL it knows will 404 — a
   * broken link is worse than an honest absence, because it fails at playback where nobody can
   * see why.
   */
  mediaUrl: string | null;
  startMs: number;
  endMs: number;
  isOpen: boolean;
  onToggle: () => void;
  /** Distinguishes this preview's controls when several sit in one list. */
  label: string;
};

export function SourceRangePreview({
  mediaUrl,
  startMs,
  endMs,
  isOpen,
  onToggle,
  label,
}: SourceRangePreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const startS = startMs / 1000;
  const endS = endMs / 1000;

  // Seek to the candidate's start once the browser knows how long the file is. The `#t=` fragment
  // in the URL asks for the same thing, but support for it varies by browser and by whether the
  // server honours it, so the reliable version is done here and the fragment is a hint.
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (Number.isFinite(startS) && startS > 0) video.currentTime = startS;
  }, [startS]);

  // The end of the candidate is not the end of the file, so the element cannot stop on its own.
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.currentTime >= endS) {
      video.pause();
      // Back to the start of the range rather than wherever it overshot, so pressing play again
      // replays the candidate instead of the sermon that follows it.
      video.currentTime = startS;
    }
  }, [endS, startS]);

  // A closed preview holds no element at all; this only matters for the open one being unmounted
  // while it plays.
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      video?.pause();
    };
  }, []);

  if (!mediaUrl) {
    return (
      <p data-testid="preview-unavailable" className="mt-2 text-xs text-stone-500">
        The sermon recording for this service has been deleted, so this moment can no longer be
        played.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onToggle}
        data-testid="preview-toggle"
        aria-expanded={isOpen}
        className="text-xs font-medium text-teal-800 underline"
      >
        {isOpen ? "Hide" : "Preview"} this moment
        <span className="sr-only"> — {label}</span>
      </button>

      {isOpen ? (
        <video
          ref={videoRef}
          data-testid="preview-video"
          // Never `autoPlay`. A church opening a service should not have a sermon start talking.
          controls
          preload="none"
          playsInline
          onLoadedMetadata={handleLoadedMetadata}
          onTimeUpdate={handleTimeUpdate}
          className="mt-2 w-full max-w-md rounded-md bg-black"
          src={`${mediaUrl}#t=${startS.toFixed(2)},${endS.toFixed(2)}`}
        >
          Your browser cannot play this recording.
        </video>
      ) : null}
    </div>
  );
}
