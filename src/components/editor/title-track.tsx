"use client";

import { useRef } from "react";
import {
  moveTitleRange,
  trimTitleRange,
  type TitleBanner,
  type TitleRange,
} from "@/lib/editor/title-banner";

type DragKind = "region" | "start" | "end";

function readKind(target: EventTarget | null): DragKind | null {
  const element = (target as HTMLElement | null)?.closest?.("[data-title-drag]");
  const kind = element?.getAttribute("data-title-drag");
  return kind === "region" || kind === "start" || kind === "end" ? kind : null;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The Title track: where the title starts and ends, dragged.
 *
 * Mounted as its own self-contained track, which is the shape `ClipTimeline` was deliberately
 * built to be copied into. One set of pointer handlers on the track dispatches by the pressed
 * element's `data-title-drag`, and the track captures the pointer, so a fast drag that leaves a
 * handle keeps tracking.
 *
 * Every number it produces comes from `moveTitleRange` and `trimTitleRange`, which are pure and
 * tested: the clamping is the part that goes wrong, and it should not live in a pointer handler.
 */
export function TitleTrack({
  title,
  clip,
  onChange,
  onCommit,
}: {
  title: TitleBanner;
  clip: TitleRange;
  onChange: (range: TitleRange) => void;
  /** The drag is over: write what it produced and close its undo entry. */
  onCommit: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ kind: DragKind; grabbedAtMs: number; range: TitleRange } | null>(null);

  const span = Math.max(1, clip.endMs - clip.startMs);
  const pctOf = (ms: number) => ((ms - clip.startMs) / span) * 100;
  const startPct = pctOf(title.startMs);
  const endPct = pctOf(title.endMs);

  function msAt(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return clip.startMs;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return clip.startMs + fraction * span;
  }

  function handlePointerDown(event: React.PointerEvent) {
    const kind = readKind(event.target);
    if (!kind) return;
    dragRef.current = {
      kind,
      grabbedAtMs: msAt(event.clientX),
      range: { startMs: title.startMs, endMs: title.endMs },
    };
    trackRef.current?.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const at = msAt(event.clientX);
    if (drag.kind === "region") {
      onChange(moveTitleRange(drag.range, at - drag.grabbedAtMs, clip));
      return;
    }
    onChange(trimTitleRange(drag.range, drag.kind, at, clip));
  }

  function endDrag(event: React.PointerEvent) {
    if (!dragRef.current) return;
    dragRef.current = null;
    trackRef.current?.releasePointerCapture?.(event.pointerId);
    onCommit();
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Title track</h3>
        <p className="text-xs font-medium text-stone-600">
          {formatClock(title.startMs)} – {formatClock(title.endMs)}
          <span className="text-stone-400">
            {" "}
            · {((title.endMs - title.startMs) / 1000).toFixed(1)}s
          </span>
        </p>
      </div>

      <div
        ref={trackRef}
        data-testid="title-track"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="relative mt-3 h-10 w-full touch-none select-none rounded-md bg-stone-100"
        role="group"
        aria-label="Title track"
      >
        <div
          data-title-drag="region"
          data-testid="title-region"
          className="absolute inset-y-0 cursor-grab rounded-md border-y-2 border-teal-500 bg-teal-500/15 active:cursor-grabbing"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
        >
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center truncate px-6 text-xs font-medium text-teal-900">
            {title.text || "Untitled"}
          </span>
        </div>

        {/* The handles sit on the region's edges and take the pointer before the region does. */}
        <div
          data-title-drag="start"
          data-testid="title-handle-start"
          aria-label="Title start"
          className="absolute inset-y-0 -ml-1.5 w-3 cursor-ew-resize rounded-l-md bg-teal-600"
          style={{ left: `${startPct}%` }}
        />
        <div
          data-title-drag="end"
          data-testid="title-handle-end"
          aria-label="Title end"
          className="absolute inset-y-0 -ml-1.5 w-3 cursor-ew-resize rounded-r-md bg-teal-600"
          style={{ left: `${endPct}%` }}
        />
      </div>

      <p className="mt-2 text-xs text-stone-500">
        Drag the block to move when the title shows; drag either edge to change where it starts or
        ends.
      </p>
    </div>
  );
}
