"use client";

import { useRef } from "react";
import {
  moveTitleRange,
  trimTitleRange,
  type TitleBanner,
  type TitleRange,
} from "@/lib/editor/title-banner";
import type { TrimViewport } from "@/lib/editor/trim";

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
 * One row of the timeline, drawn on the window every row shares (`view`) and clamped to the clip
 * (`clip`). A title lives inside the clip, so the source on either side of it is dimmed here
 * exactly as it is on the Video row, and a drag stops at the clip's edges however far the window
 * extends past them.
 *
 * One set of pointer handlers on the row dispatches by the pressed element's `data-title-drag`,
 * and the row captures the pointer, so a fast drag that leaves a handle keeps tracking. A claimed
 * gesture stops propagating, so the timeline surface underneath does not also take it as a scrub.
 *
 * Every number it produces comes from `moveTitleRange` and `trimTitleRange`, which are pure and
 * tested: the clamping is the part that goes wrong, and it should not live in a pointer handler.
 *
 * With no title the row offers one. Taking the offer is `onAdd`; what a new title is belongs to
 * the parent, which owns the document.
 */
export function TitleTrack({
  title,
  clip,
  view,
  onChange,
  onCommit,
  onAdd,
}: {
  title: TitleBanner | null;
  clip: TitleRange;
  /** The visible window, shared with every row, so the rows line up. */
  view: TrimViewport;
  onChange: (range: TitleRange) => void;
  /** The drag is over: write what it produced and close its undo entry. */
  onCommit: () => void;
  /** The empty row's offer was taken. */
  onAdd: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ kind: DragKind; grabbedAtMs: number; range: TitleRange } | null>(null);

  const span = Math.max(1, view.end - view.start);
  const pctOf = (ms: number) => Math.min(100, Math.max(0, ((ms - view.start) / span) * 100));
  const clipStartPct = pctOf(clip.startMs);
  const clipEndPct = pctOf(clip.endMs);

  function msAt(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return view.start;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return view.start + fraction * span;
  }

  function handlePointerDown(event: React.PointerEvent) {
    if (!title) return;
    const kind = readKind(event.target);
    if (!kind) return;
    event.stopPropagation();
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
    event.stopPropagation();
    const at = msAt(event.clientX);
    if (drag.kind === "region") {
      onChange(moveTitleRange(drag.range, at - drag.grabbedAtMs, clip));
      return;
    }
    onChange(trimTitleRange(drag.range, drag.kind, at, clip));
  }

  function endDrag(event: React.PointerEvent) {
    if (!dragRef.current) return;
    event.stopPropagation();
    dragRef.current = null;
    trackRef.current?.releasePointerCapture?.(event.pointerId);
    onCommit();
  }

  const startPct = title ? pctOf(title.startMs) : clipStartPct;
  const endPct = title ? pctOf(title.endMs) : clipEndPct;

  return (
    <div
      ref={trackRef}
      data-testid="title-track"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="relative h-full w-full touch-none select-none rounded-md bg-stone-100"
      role="group"
      aria-label="Title track"
    >
      {/* Source the clip excludes, dimmed on each side exactly as on the Video row. */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 rounded-l-md bg-stone-200/80"
        style={{ width: `${clipStartPct}%` }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 right-0 rounded-r-md bg-stone-200/80"
        style={{ left: `${clipEndPct}%` }}
      />

      {title ? (
        <>
          <div
            data-title-drag="region"
            data-testid="title-region"
            title={`${formatClock(title.startMs)} – ${formatClock(title.endMs)}`}
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
        </>
      ) : (
        <div
          className="absolute inset-y-1"
          style={{ left: `${clipStartPct}%`, width: `${Math.max(0, clipEndPct - clipStartPct)}%` }}
        >
          <button
            type="button"
            data-testid="title-track-add"
            title="Add a three-second title at the top of the clip"
            // A press here is taking the offer, not previewing that spot on the surface below.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onAdd}
            className="flex h-full w-full items-center justify-center rounded-md border border-dashed border-stone-300 text-xs font-medium text-stone-500 hover:border-teal-500 hover:bg-white hover:text-teal-800"
          >
            Add a title
          </button>
        </div>
      )}
    </div>
  );
}
