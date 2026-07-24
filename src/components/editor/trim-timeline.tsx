"use client";

import { useRef, useState } from "react";

const MIN_CLIP_MS = 5_000;
// The track shows the clip plus this much context on each side — a full-length sermon on one
// track would make one pixel ≈ several seconds, too coarse to place a boundary by hand.
const VIEW_PAD_MS = 30_000;
const KEYBOARD_STEP_MS = 1_000;
const KEYBOARD_BIG_STEP_MS = 5_000;

function formatMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Draggable start/end handles over a zoomed-in slice of the source timeline. Edits are
 * non-destructive: they only move the editor state's source range (what the preview plays and
 * the export renders) — the source video and the clip's original suggestion are untouched.
 */
export function TrimTimeline({
  startMs,
  endMs,
  sourceDurationMs,
  onChange,
}: {
  startMs: number;
  endMs: number;
  sourceDurationMs: number;
  onChange: (next: { startMs: number; endMs: number }) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  // The visible window is frozen while a handle is held, so dragging toward an edge doesn't
  // re-derive the window from the value being dragged and make the handle chase its own tail.
  const [frozenView, setFrozenView] = useState<{ start: number; end: number } | null>(null);

  const view =
    dragging && frozenView
      ? frozenView
      : {
          start: Math.max(0, startMs - VIEW_PAD_MS),
          end: Math.min(sourceDurationMs, endMs + VIEW_PAD_MS),
        };
  const viewSpan = Math.max(1, view.end - view.start);

  function msFromPointer(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return startMs;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round((view.start + ratio * viewSpan) / 100) * 100;
  }

  function applyStart(ms: number) {
    onChange({ startMs: Math.min(Math.max(0, ms), endMs - MIN_CLIP_MS), endMs });
  }

  function applyEnd(ms: number) {
    onChange({ startMs, endMs: Math.max(Math.min(sourceDurationMs, ms), startMs + MIN_CLIP_MS) });
  }

  function handlePointerDown(handle: "start" | "end") {
    return (event: React.PointerEvent<HTMLDivElement>) => {
      setFrozenView(view);
      setDragging(handle);
      event.currentTarget.setPointerCapture(event.pointerId);
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    const ms = msFromPointer(event.clientX);
    if (dragging === "start") applyStart(ms);
    else applyEnd(ms);
  }

  function handlePointerUp() {
    setDragging(null);
    setFrozenView(null);
  }

  function handleKeyDown(handle: "start" | "end") {
    return (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? KEYBOARD_BIG_STEP_MS : KEYBOARD_STEP_MS;
      const delta =
        event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : null;
      if (delta === null) return;
      event.preventDefault();
      if (handle === "start") applyStart(startMs + delta);
      else applyEnd(endMs + delta);
    };
  }

  const startPct = ((startMs - view.start) / viewSpan) * 100;
  const endPct = ((endMs - view.start) / viewSpan) * 100;

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between text-xs text-stone-600">
        <span>Start {formatMs(startMs)}</span>
        <span className="font-medium text-stone-700">{formatMs(endMs - startMs)} clip</span>
        <span>End {formatMs(endMs)}</span>
      </div>
      <div
        ref={trackRef}
        className="relative mt-2 h-9 touch-none select-none rounded-md bg-stone-200"
      >
        <div
          className="absolute inset-y-0 rounded-md bg-teal-600/30"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
        />
        {(["start", "end"] as const).map((handle) => (
          <div
            key={handle}
            role="slider"
            tabIndex={0}
            aria-label={handle === "start" ? "Clip start" : "Clip end"}
            aria-valuemin={0}
            aria-valuemax={Math.round(sourceDurationMs / 1000)}
            aria-valuenow={Math.round((handle === "start" ? startMs : endMs) / 1000)}
            aria-valuetext={formatMs(handle === "start" ? startMs : endMs)}
            onPointerDown={handlePointerDown(handle)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onKeyDown={handleKeyDown(handle)}
            className="absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-teal-700 shadow focus:outline-none focus:ring-2 focus:ring-teal-500"
            style={{ left: `${handle === "start" ? startPct : endPct}%` }}
          />
        ))}
      </div>
      <p className="mt-2 text-xs text-stone-500">
        Drag the handles (or use arrow keys) to trim where the clip starts and ends. Changes only
        affect this clip&apos;s edit — the original video is never modified.
      </p>
    </div>
  );
}
