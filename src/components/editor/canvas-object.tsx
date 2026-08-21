"use client";

import { useRef, type ReactNode } from "react";
import {
  deltaToCanvasPct,
  moveObject,
  resizeFontPx,
  type CanvasPoint,
  type CanvasRect,
  type CanvasViewport,
} from "@/lib/editor/canvas";

/**
 * One directly-manipulable object on the editing canvas: selectable, draggable, and resizable by
 * its four corners.
 *
 * It owns the gesture and nothing else. What the object *is* — a caption, and in Slice 9 a title —
 * is the caller's `children`; where it lives and how big it is are the caller's document values.
 * Slice 9 is meant to mount this rather than grow a second implementation, which is why nothing
 * here knows what it is wrapping.
 */

export type CanvasObjectGesture = "move" | "resize";

const CORNERS = [
  { key: "top-left", label: "Resize from the top left", className: "-left-1 -top-1 cursor-nwse-resize" },
  { key: "top-right", label: "Resize from the top right", className: "-right-1 -top-1 cursor-nesw-resize" },
  { key: "bottom-left", label: "Resize from the bottom left", className: "-left-1 -bottom-1 cursor-nesw-resize" },
  { key: "bottom-right", label: "Resize from the bottom right", className: "-right-1 -bottom-1 cursor-nwse-resize" },
] as const;

export function CanvasObject({
  label,
  point,
  sizePx,
  minSizePx,
  maxSizePx,
  selected,
  viewport,
  rectRef,
  onSelect,
  onMove,
  onResize,
  onCommit,
  children,
}: {
  /** Names the object for assistive technology and for tests. */
  label: string;
  point: CanvasPoint;
  sizePx: number;
  minSizePx: number;
  maxSizePx: number;
  selected: boolean;
  viewport: CanvasViewport;
  /** The canvas element's on-screen box, read at gesture time rather than during render. */
  rectRef: () => CanvasRect | null;
  onSelect: () => void;
  /** A frame of a move. `snappedToCentre` drives the centre guide. */
  onMove: (next: CanvasPoint, snappedToCentre: boolean) => void;
  onResize: (nextSizePx: number) => void;
  /** The gesture ended: write it, and close its undo entry. */
  onCommit: (gesture: CanvasObjectGesture) => void;
  children: ReactNode;
}) {
  // Gesture state lives in a ref, not in React state: it changes on every pointer frame and
  // nothing renders from it. Written and read only inside handlers, never during render.
  const gestureRef = useRef<{
    kind: CanvasObjectGesture;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startPoint: CanvasPoint;
    startSizePx: number;
    startDistancePx: number;
  } | null>(null);

  function beginMove(event: React.PointerEvent) {
    // Only a primary press starts a drag, and a two-finger gesture belongs to the canvas
    // (pinch-zoom), not to the object under one of the fingers.
    if (!event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    gestureRef.current = {
      kind: "move",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPoint: point,
      startSizePx: sizePx,
      startDistancePx: 0,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function beginResize(event: React.PointerEvent) {
    if (!event.isPrimary) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect();

    const rect = rectRef();
    // The corner's distance from the object's centre is what the gesture scales.
    const centreX = rect ? rect.left + point.xPct * rect.width : event.clientX;
    const centreY = rect ? rect.top + point.yPct * rect.height : event.clientY;
    gestureRef.current = {
      kind: "resize",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPoint: point,
      startSizePx: sizePx,
      startDistancePx: Math.hypot(event.clientX - centreX, event.clientY - centreY),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const rect = rectRef();
    if (!rect) return;
    event.preventDefault();

    if (gesture.kind === "move") {
      const { dxPct, dyPct } = deltaToCanvasPct({
        dxPx: event.clientX - gesture.startClientX,
        dyPx: event.clientY - gesture.startClientY,
        rect,
        viewport,
      });
      const moved = moveObject(gesture.startPoint, dxPct, dyPct);
      onMove(moved.point, moved.snappedToCentre);
      return;
    }

    const centreX = rect.left + gesture.startPoint.xPct * rect.width;
    const centreY = rect.top + gesture.startPoint.yPct * rect.height;
    onResize(
      resizeFontPx({
        startSizePx: gesture.startSizePx,
        startDistancePx: gesture.startDistancePx,
        currentDistancePx: Math.hypot(event.clientX - centreX, event.clientY - centreY),
        minPx: minSizePx,
        maxPx: maxSizePx,
      }),
    );
  }

  function endGesture(event: React.PointerEvent) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onCommit(gesture.kind);
  }

  return (
    <div
      data-testid="canvas-object"
      data-selected={selected ? "true" : "false"}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected}
      onPointerDown={beginMove}
      onPointerMove={handlePointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      // Keyboard users get selection; the position controls remain reachable elsewhere.
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
      className={`absolute touch-none select-none ${
        selected ? "cursor-move" : "cursor-pointer"
      }`}
      style={{
        left: `${point.xPct * 100}%`,
        top: `${point.yPct * 100}%`,
        transform: "translate(-50%, -50%)",
      }}
    >
      {/*
        One thin border, and nothing else. No label sits on the object: a caption that has to
        carry instructions across it is not direct manipulation.
      */}
      <div
        className={
          selected
            ? "relative rounded-[2px] border border-teal-300/90"
            : "relative rounded-[2px] border border-transparent"
        }
      >
        {children}

        {selected
          ? CORNERS.map((corner) => (
              <span
                key={corner.key}
                data-testid={`canvas-handle-${corner.key}`}
                role="button"
                tabIndex={-1}
                aria-label={`${corner.label} of the ${label}`}
                onPointerDown={beginResize}
                onPointerMove={handlePointerMove}
                onPointerUp={endGesture}
                onPointerCancel={endGesture}
                className={`absolute h-2.5 w-2.5 rounded-[1px] border border-teal-700 bg-white ${corner.className}`}
              />
            ))
          : null}
      </div>
    </div>
  );
}
