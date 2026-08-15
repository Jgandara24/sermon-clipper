"use client";

import { Scissors } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
  clampEnd,
  clampRegion,
  clampStart,
  computeTrimViewport,
  snapToBoundary,
  type TrimViewport,
} from "@/lib/editor/trim";

// Nearest-boundary snap distance, as a fraction of the visible window — a couple percent, so it
// grabs a word edge you're clearly aiming at without fighting fine adjustments.
const SNAP_FRACTION = 0.02;
// Keyboard nudge steps for the handles (accessibility): a small step, and a larger one with Shift.
const NUDGE_MS = 200;
const NUDGE_LARGE_MS = 1_000;

type DragKind = "start" | "end" | "region";

function formatClock(ms: number): string {
  const totalS = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalS / 60)}:${String(totalS % 60).padStart(2, "0")}`;
}

function readKind(target: EventTarget | null): DragKind | null {
  const el = (target as HTMLElement | null)?.closest?.("[data-trim]");
  const kind = el?.getAttribute("data-trim");
  return kind === "start" || kind === "end" || kind === "region" ? kind : null;
}

/**
 * Drag-to-trim timeline: the primary control for a clip's in/out points. Handles set
 * state.source.startMs/endMs (via onTrim) snapping to word boundaries; the middle drags the whole
 * window; clicking the bare track previews a spot (onScrub). Deliberately a single self-contained
 * track so the upcoming canvas text / banner overlay controls can mount their own timelines the
 * same way. A single set of pointer handlers on the track (dispatching by the pressed element's
 * data-trim attribute) keeps ref access out of per-render closures, and pointer capture on the
 * track means a fast drag that leaves the handle keeps tracking.
 */
export function ClipTimeline({
  sourceDurationMs,
  startMs,
  endMs,
  currentMs,
  wordBoundaries,
  onTrim,
  onScrub,
  onInteractionStart,
  onInteractionEnd,
  compact = false,
}: {
  sourceDurationMs: number;
  startMs: number;
  endMs: number;
  currentMs: number;
  wordBoundaries: number[];
  onTrim: (startMs: number, endMs: number) => void;
  onScrub: (ms: number) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  compact?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ kind: DragKind; grabOffsetMs: number } | null>(null);
  // The viewport is derived from the clip each render, EXCEPT while dragging, when it's held to
  // the value captured at pointer-down (in `frozenView`) — so the pixel↔time scale doesn't shift
  // under the pointer as the clip edges move mid-gesture.
  const [frozenView, setFrozenView] = useState<TrimViewport | null>(null);
  const view = frozenView ?? computeTrimViewport(startMs, endMs, sourceDurationMs);

  const span = Math.max(1, view.end - view.start);
  const msToPct = useCallback(
    (ms: number) => Math.min(100, Math.max(0, ((ms - view.start) / span) * 100)),
    [view.start, span],
  );

  const clientXToMs = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return view.start;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return view.start + ratio * span;
    },
    [view.start, span],
  );

  const snap = useCallback(
    (ms: number) => snapToBoundary(ms, wordBoundaries, span * SNAP_FRACTION),
    [wordBoundaries, span],
  );

  const handlePointerDown = (event: React.PointerEvent) => {
    const kind = readKind(event.target);
    if (!kind) {
      // Bare track (or a dimmed edge) → preview that spot.
      onScrub(Math.round(clientXToMs(event.clientX)));
      return;
    }
    event.preventDefault();
    const ms = clientXToMs(event.clientX);
    dragRef.current = { kind, grabOffsetMs: kind === "region" ? ms - startMs : 0 };
    onInteractionStart?.();
    setFrozenView(computeTrimViewport(startMs, endMs, sourceDurationMs));
    trackRef.current?.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const ms = clientXToMs(event.clientX);
    if (drag.kind === "start") {
      const next = clampStart(snap(ms), endMs);
      onTrim(next, endMs);
      onScrub(next);
    } else if (drag.kind === "end") {
      const next = clampEnd(snap(ms), startMs, sourceDurationMs);
      onTrim(startMs, next);
      onScrub(next);
    } else {
      const region = clampRegion(ms - drag.grabOffsetMs, endMs - startMs, sourceDurationMs);
      onTrim(region.startMs, region.endMs);
    }
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    trackRef.current?.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    setFrozenView(null);
    onInteractionEnd?.();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const kind = event.currentTarget.getAttribute("data-trim");
    const dir = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (dir === 0) return;
    event.preventDefault();
    const delta = dir * (event.shiftKey ? NUDGE_LARGE_MS : NUDGE_MS);
    if (kind === "start") {
      const next = clampStart(startMs + delta, endMs);
      onTrim(next, endMs);
      onScrub(next);
    } else if (kind === "end") {
      const next = clampEnd(endMs + delta, startMs, sourceDurationMs);
      onTrim(startMs, next);
      onScrub(next);
    }
  };

  const startPct = msToPct(startMs);
  const endPct = msToPct(endMs);
  const playheadVisible = currentMs >= view.start && currentMs <= view.end;

  return (
    <div
      className={
        compact
          ? "h-full bg-[#181818] px-3 py-2 text-white lg:px-5 lg:py-3"
          : "rounded-lg border border-stone-200 bg-white p-5 shadow-sm"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Scissors size={18} className={compact ? "text-red-500" : "text-red-700"} aria-hidden="true" />
          <h2 className="font-semibold">Trim</h2>
        </div>
        <p className={`text-xs font-medium ${compact ? "text-stone-300" : "text-stone-600"}`}>
          {formatClock(startMs)} – {formatClock(endMs)}
          <span className="text-stone-400"> · {formatClock(endMs - startMs)} long</span>
        </p>
      </div>
      {!compact ? (
        <p className="mt-2 text-xs text-stone-500">
          Drag the handles to set where the clip starts and ends. Drag the middle to move the whole
          clip; click the track to preview a spot. Handles snap to the nearest spoken word.
        </p>
      ) : null}

      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`relative mt-2 w-full touch-none select-none rounded-md lg:mt-3 ${compact ? "h-11 bg-black lg:h-14" : "h-16 bg-stone-100"}`}
        role="group"
        aria-label="Clip trim timeline"
      >
        {/* Trimmed-away source, dimmed on each side of the selection. */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 rounded-l-md bg-stone-200/80"
          style={{ width: `${startPct}%` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 rounded-r-md bg-stone-200/80"
          style={{ left: `${endPct}%` }}
        />

        {/* The selected clip window — draggable to reposition. */}
        <div
          data-trim="region"
          className="absolute inset-y-0 cursor-grab border-y-2 border-red-500 bg-red-500/15 active:cursor-grabbing"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
          aria-hidden="true"
        />

        {/* Playhead. */}
        {playheadVisible ? (
          <div
            className="pointer-events-none absolute inset-y-0 z-20 w-0.5 bg-red-500"
            style={{ left: `${msToPct(currentMs)}%` }}
          />
        ) : null}

        <TrimHandle
          kind="start"
          pct={startPct}
          valueNow={startMs}
          valueMax={sourceDurationMs}
          valueLabel={formatClock(startMs)}
          onKeyDown={handleKeyDown}
        />
        <TrimHandle
          kind="end"
          pct={endPct}
          valueNow={endMs}
          valueMax={sourceDurationMs}
          valueLabel={formatClock(endMs)}
          onKeyDown={handleKeyDown}
        />
      </div>

      <div className={`mt-1 flex justify-between text-[10px] ${compact ? "text-stone-500" : "text-stone-400"}`}>
        <span>{formatClock(view.start)}</span>
        <span>{formatClock(view.end)}</span>
      </div>
    </div>
  );
}

function TrimHandle({
  kind,
  pct,
  valueNow,
  valueMax,
  valueLabel,
  onKeyDown,
}: {
  kind: "start" | "end";
  pct: number;
  valueNow: number;
  valueMax: number;
  valueLabel: string;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  return (
    <div
      data-trim={kind}
      onKeyDown={onKeyDown}
      role="slider"
      tabIndex={0}
      aria-label={kind === "start" ? "Clip start" : "Clip end"}
      aria-valuemin={0}
      aria-valuemax={Math.round(valueMax)}
      aria-valuenow={Math.round(valueNow)}
      aria-valuetext={valueLabel}
      className="absolute inset-y-0 z-10 flex w-11 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-red-600 lg:w-4"
      style={{ left: `${pct}%` }}
    >
      <div className="pointer-events-none h-full w-1.5 rounded bg-red-600 shadow" />
    </div>
  );
}
