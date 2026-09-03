"use client";

import { ChevronFirst, ChevronLast, Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { SKIP_STEP_MS } from "@/lib/editor/playback";

/**
 * What the preview lets the transport do to it. The video element stays inside the preview —
 * playing, seeking and skipping are its own business — and the buttons that ask for them live
 * above the timeline's tracks, where the plan puts them.
 */
export type PreviewTransport = {
  togglePlay: () => void;
  seekTo: (ms: number) => void;
  skipBy: (deltaMs: number) => void;
};

/**
 * The transport: to the start, back, play or pause, forward, to the end.
 *
 * Centred above the tracks. The names are the ones the playback suite drives, and they are the
 * same names the preview's own bar used before the controls moved here.
 */
export function TransportControls({
  isPlaying,
  clip,
  transportRef,
}: {
  isPlaying: boolean;
  clip: { startMs: number; endMs: number };
  /** Read when a button is pressed, not when this renders: the preview fills it after mounting. */
  transportRef: React.RefObject<PreviewTransport | null>;
}) {
  const transport = () => transportRef.current;
  return (
    <div
      data-testid="transport-controls"
      role="group"
      aria-label="Playback"
      className="flex items-center gap-1 rounded-md bg-stone-900 px-2 py-1 text-white"
    >
      <TransportButton label="Go to start" onClick={() => transport()?.seekTo(clip.startMs)}>
        <ChevronFirst size={16} aria-hidden="true" />
      </TransportButton>
      <TransportButton label="Back 3 seconds" onClick={() => transport()?.skipBy(-SKIP_STEP_MS)}>
        <RotateCcw size={16} aria-hidden="true" />
      </TransportButton>
      <TransportButton
        label={isPlaying ? "Pause" : "Play clip"}
        onClick={() => transport()?.togglePlay()}
      >
        {isPlaying ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
      </TransportButton>
      <TransportButton label="Forward 3 seconds" onClick={() => transport()?.skipBy(SKIP_STEP_MS)}>
        <RotateCw size={16} aria-hidden="true" />
      </TransportButton>
      {/* Seeks to the clip end and stays there, rather than restarting the clip. */}
      <TransportButton label="Go to end" onClick={() => transport()?.seekTo(clip.endMs)}>
        <ChevronLast size={16} aria-hidden="true" />
      </TransportButton>
    </div>
  );
}

function TransportButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-md p-2 text-white/90 hover:bg-white/15"
    >
      {children}
    </button>
  );
}
