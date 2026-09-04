"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  centredVideoBox,
  clampPanelWidths,
  PANEL_LIMITS,
  resizeDivider,
  VIDEO_MIN_PX,
  type PanelName,
} from "@/lib/editor/panel-resize";

/** Below this the three columns cannot all hold their minimums, so the areas stack instead. */
const STACK_BELOW_PX = 820;
const DIVIDER_PX = 10;
/** Keyboard step for a divider, and the larger step with Shift. */
const NUDGE_PX = 16;
const NUDGE_LARGE_PX = 64;

/** Equal to begin with, so the picture opens centred whatever the window is. */
const START_WIDTHS = { transcript: 300, style: 300 };

/**
 * The editor's areas: Transcript, Video and Style side by side, Timeline underneath.
 *
 * The two dividers are dragged, and every number they produce comes from `panel-resize`, which is
 * pure and tested. Widths are view state and are never saved — how the editor is arranged cannot
 * change what is exported, the same rule the canvas viewport follows.
 *
 * The video is padded inside its own column until its centre lands on the centre of all three
 * columns, so widening a panel on one side does not slide the picture off to the other.
 *
 * Narrow windows stack the areas and drop the dividers: below `STACK_BELOW_PX` the three columns
 * cannot hold their minimums at once, and a divider that cannot move is worse than no divider.
 */
export function EditorColumns({
  transcript,
  video,
  style,
  timeline,
}: {
  transcript: React.ReactNode;
  video: React.ReactNode;
  style: React.ReactNode;
  timeline: React.ReactNode;
}) {
  const columnsRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [widths, setWidths] = useState(START_WIDTHS);
  const dragRef = useRef<{ divider: PanelName; originClientX: number; startWidths: typeof widths } | null>(
    null,
  );

  useEffect(() => {
    const element = columnsRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width ?? 0;
      if (width > 0) setContainerWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Nothing is sized until the container has been measured: an inline width computed from a zero
  // container would give the video no width at all for the first frame, and a video with no size
  // is a video that cannot be played.
  const measured = containerWidth > 0;
  const stacked = measured && containerWidth < STACK_BELOW_PX;
  const usable = Math.max(0, containerWidth - DIVIDER_PX * 2);
  const settled = containerWidth > 0 ? clampPanelWidths({ containerWidth: usable, ...widths }) : widths;
  const box = centredVideoBox({ containerWidth: usable, ...settled });

  const applyDrag = useCallback(
    (divider: PanelName, deltaPx: number, from: typeof widths) => {
      setWidths(resizeDivider({ divider, containerWidth: usable, ...from, deltaPx }));
    },
    [usable],
  );

  /** Which divider an event belongs to, read from the element rather than from a closure. */
  function readDivider(target: EventTarget | null): PanelName | null {
    const name = (target as HTMLElement | null)?.getAttribute?.("data-divider");
    return name === "transcript" || name === "style" ? name : null;
  }

  function handlePointerDown(event: React.PointerEvent) {
    const divider = readDivider(event.currentTarget);
    if (!divider) return;
    event.preventDefault();
    dragRef.current = { divider, originClientX: event.clientX, startWidths: settled };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    applyDrag(drag.divider, event.clientX - drag.originClientX, drag.startWidths);
  }

  function endDrag(event: React.PointerEvent) {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    const divider = readDivider(event.currentTarget);
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!divider || direction === 0) return;
    event.preventDefault();
    applyDrag(divider, direction * (event.shiftKey ? NUDGE_LARGE_PX : NUDGE_PX), settled);
  }

  /**
   * The parts of a divider that do not read the drag. The handlers are attached in the JSX
   * directly: a helper that returned them would be a function called during render holding a ref,
   * which is exactly what the compiler refuses.
   */
  const dividerChrome = (divider: PanelName) => ({
    "data-testid": `divider-${divider}`,
    "data-divider": divider,
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-label": divider === "transcript" ? "Resize the transcript" : "Resize the style panel",
    "aria-valuemin": PANEL_LIMITS[divider].min,
    "aria-valuemax": PANEL_LIMITS[divider].max,
    "aria-valuenow": Math.round(settled[divider]),
    tabIndex: 0,
    title: "Drag, or use the arrow keys, to resize",
    className:
      "group flex w-2.5 shrink-0 cursor-col-resize touch-none items-center justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600",
  });

  return (
    <div className="grid gap-6">
      <div
        ref={columnsRef}
        data-testid="editor-columns"
        className={!measured || stacked ? "grid gap-6" : "flex items-stretch"}
      >
        <Area
          name="transcript"
          heading="Transcript"
          width={measured && !stacked ? settled.transcript : undefined}
        >
          {transcript}
        </Area>

        {measured && !stacked ? (
          <div
            {...dividerChrome("transcript")}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={handleKeyDown}
          >
            <span className="h-16 w-0.5 rounded bg-stone-300 group-hover:bg-teal-600" />
          </div>
        ) : null}

        <Area name="video" heading="Video" grow={!stacked}>
          {/* Padded until the picture's own centre is the centre of all three columns. */}
          <div
            data-testid="video-box"
            className="mx-auto"
            style={
              measured && !stacked
                ? {
                    width: `${box.width}px`,
                    marginLeft: `${box.padLeft}px`,
                    marginRight: `${box.padRight}px`,
                  }
                : undefined
            }
          >
            {video}
          </div>
        </Area>

        {measured && !stacked ? (
          <div
            {...dividerChrome("style")}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onKeyDown={handleKeyDown}
          >
            <span className="h-16 w-0.5 rounded bg-stone-300 group-hover:bg-teal-600" />
          </div>
        ) : null}

        <Area
          name="style"
          heading="Style"
          width={measured && !stacked ? settled.style : undefined}
        >
          {style}
        </Area>
      </div>

      <Area name="timeline" heading="Timeline">
        {timeline}
      </Area>
    </div>
  );
}

function Area({
  name,
  heading,
  width,
  grow,
  children,
}: {
  name: string;
  heading: string;
  width?: number;
  grow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={`area-${name}`}
      aria-label={heading}
      style={width === undefined ? undefined : { width: `${width}px` }}
      className={`flex min-w-0 flex-col gap-3 ${grow ? "flex-1" : ""}`}
    >
      <h2 className="text-center text-xs font-semibold uppercase tracking-[0.14em] text-teal-800">
        {heading}
      </h2>
      {children}
    </section>
  );
}

export { VIDEO_MIN_PX };
