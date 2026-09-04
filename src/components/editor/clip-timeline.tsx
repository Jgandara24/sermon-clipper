"use client";

import { positionFromPointer } from "@/lib/editor/playback";
import { Maximize, Scissors, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { TitleBanner, TitleRange } from "@/lib/editor/title-banner";
import {
  clampEnd,
  clampRegion,
  clampStart,
  computeTrimViewport,
  snapToBoundary,
  stepTimelineZoom,
  TIMELINE_ZOOM_MAX,
  TIMELINE_ZOOM_MIN,
  type TrimViewport,
} from "@/lib/editor/trim";
import { normalisePeaks } from "@/lib/media/wav";
import { chooseDensityBucketMs, wordDensityBars } from "@/lib/editor/word-density";
import { AudioTrack } from "./audio-track";
import { TitleTrack } from "./title-track";
import { useAudioPeaks } from "./use-audio-peaks";
import { VideoFrames } from "./video-frames";

// Nearest-boundary snap distance, as a fraction of the visible window — a couple percent, so it
// grabs a word edge you're clearly aiming at without fighting fine adjustments.
const SNAP_FRACTION = 0.02;
// Keyboard nudge steps for the handles (accessibility): a small step, and a larger one with Shift.
const NUDGE_MS = 200;
const NUDGE_LARGE_MS = 1_000;

type DragKind = "start" | "end" | "region" | "playhead";

/** The rows, which are also what the settings beside the timeline follow. */
export type TimelineTrack = "title" | "video" | "audio";

/** Pointer travel below this is a click, not a drag. */
const CLICK_SLOP_PX = 3;

/**
 * The rows, top to bottom. The label column and the surface stack these same heights, so a label
 * sits beside its row; the ruler at the top is the playhead's strip and has no label.
 */
const RULER_CLASS = "h-11";
const TITLE_ROW_CLASS = "mt-1.5 h-10";
const VIDEO_ROW_CLASS = "mt-1.5 h-16";
const AUDIO_ROW_CLASS = "mt-1.5 h-10";

function formatClock(ms: number): string {
  const totalS = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalS / 60)}:${String(totalS % 60).padStart(2, "0")}`;
}

function formatZoom(zoom: number): string {
  return `${zoom}×`;
}

function readKind(target: EventTarget | null): DragKind | null {
  const el = (target as HTMLElement | null)?.closest?.("[data-trim]");
  const kind = el?.getAttribute("data-trim");
  return kind === "start" || kind === "end" || kind === "region" || kind === "playhead"
    ? kind
    : null;
}

function readTrack(target: EventTarget | null): TimelineTrack | null {
  const el = (target as HTMLElement | null)?.closest?.("[data-track]");
  const track = el?.getAttribute("data-track");
  return track === "title" || track === "video" || track === "audio" ? track : null;
}

/**
 * The timeline: Title, Video and Audio rows on one surface, one pixel↔time scale.
 *
 * The Video row is the primary control for a clip's in/out points. Handles set
 * state.source.startMs/endMs (via onTrim) snapping to word boundaries; the middle drags the whole
 * window; clicking bare surface — any row — previews that spot (onScrub). A single set of pointer
 * handlers on the surface (dispatching by the pressed element's data-trim attribute) keeps ref
 * access out of per-render closures, and pointer capture on the surface means a fast drag that
 * leaves the handle keeps tracking.
 *
 * The Title row is `TitleTrack`, mounted inside the surface and drawn on the same window; it
 * claims its own gestures and stops them propagating. The Audio row draws what `wordDensityBars`
 * hands it. Neither row has a pointer↔time mapping of its own that could disagree with this one.
 */
export function ClipTimeline({
  sourceVideoUrl,
  sourceDurationMs,
  startMs,
  endMs,
  currentMs,
  wordBoundaries,
  wordStartsMs,
  audio,
  title,
  zoom,
  onZoomChange,
  transport,
  activeTrack,
  onSelectTrack,
  onTrim,
  onCommitTrim,
  onScrub,
}: {
  /** The signed source URL the preview plays, for the Video row's frames. */
  sourceVideoUrl: string;
  sourceDurationMs: number;
  startMs: number;
  endMs: number;
  currentMs: number;
  wordBoundaries: number[];
  /** Every word's start on the source timeline, for the Audio row until its audio arrives. */
  wordStartsMs: number[];
  /** The source whose peaks the Audio row asks for. */
  audio: { videoId: string };
  title: {
    banner: TitleBanner | null;
    onChange: (range: TitleRange) => void;
    onCommit: () => void;
    onAdd: () => void;
  };
  /** Magnification of the window's padding. View state: never saved, never a trim limit. */
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** The transport, rendered centred above the tracks. The preview owns what it drives. */
  transport: React.ReactNode;
  /** Which row's settings are open. View state: pressing a row or its label changes it. */
  activeTrack: TimelineTrack;
  onSelectTrack: (track: TimelineTrack) => void;
  onTrim: (startMs: number, endMs: number) => void;
  /** The drag or nudge is over: write what it produced. */
  onCommitTrim: () => void;
  onScrub: (ms: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    kind: DragKind;
    grabOffsetMs: number;
    /** Where the gesture began, so a click can be told from a drag. */
    originClientX: number;
    moved: boolean;
  } | null>(null);
  // The viewport is derived from the clip each render, EXCEPT while dragging, when it's held to
  // the value captured at pointer-down (in `frozenView`) — so the pixel↔time scale doesn't shift
  // under the pointer as the clip edges move mid-gesture.
  const [frozenView, setFrozenView] = useState<TrimViewport | null>(null);
  const view = frozenView ?? computeTrimViewport(startMs, endMs, sourceDurationMs, zoom);

  const span = Math.max(1, view.end - view.start);
  const msToPct = useCallback(
    (ms: number) => Math.min(100, Math.max(0, ((ms - view.start) / span) * 100)),
    [view.start, span],
  );

  const clientXToMs = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return view.start;
      return positionFromPointer(clientX, rect, view.start, view.start + span);
    },
    [view.start, span],
  );

  /** The playhead lives inside the clip: scrubbing never leaves the trimmed window. */
  const clampPlayhead = useCallback(
    (ms: number) => Math.min(endMs, Math.max(startMs, ms)),
    [startMs, endMs],
  );

  const snap = useCallback(
    (ms: number) => snapToBoundary(ms, wordBoundaries, span * SNAP_FRACTION),
    [wordBoundaries, span],
  );

  // The Audio row: real peaks once the source's audio has arrived, speech density until then.
  // Both are bucketed the same way, so the row does not change shape when the sound arrives.
  const bucketMs = chooseDensityBucketMs(span);
  const bucketCount = Math.ceil(span / bucketMs);
  const audioPeaks = useAudioPeaks(
    audio.videoId,
    { start: view.start, end: view.start + span },
    bucketCount,
    sourceDurationMs,
  );
  const audioBars = useMemo(
    () =>
      audioPeaks
        ? normalisePeaks(audioPeaks)
        : wordDensityBars(wordStartsMs, { start: view.start, end: view.start + span }, bucketMs),
    [audioPeaks, wordStartsMs, view.start, span, bucketMs],
  );

  const handlePointerDown = (event: React.PointerEvent) => {
    const kind = readKind(event.target);
    if (!kind) {
      // Bare surface (any row, or a dimmed edge) → preview that spot.
      onScrub(Math.round(clientXToMs(event.clientX)));
      return;
    }
    event.preventDefault();
    const ms = clientXToMs(event.clientX);
    if (kind === "playhead") {
      dragRef.current = { kind, grabOffsetMs: 0, originClientX: event.clientX, moved: false };
      trackRef.current?.setPointerCapture(event.pointerId);
      onScrub(Math.round(clampPlayhead(ms)));
      return;
    }
    dragRef.current = {
      kind,
      grabOffsetMs: kind === "region" ? ms - startMs : 0,
      originClientX: event.clientX,
      moved: false,
    };
    setFrozenView(computeTrimViewport(startMs, endMs, sourceDurationMs, zoom));
    trackRef.current?.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.abs(event.clientX - drag.originClientX) > CLICK_SLOP_PX) drag.moved = true;
    const ms = clientXToMs(event.clientX);
    if (drag.kind === "playhead") {
      onScrub(Math.round(clampPlayhead(ms)));
      return;
    }
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
    const drag = dragRef.current;
    if (!drag) return;
    trackRef.current?.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    setFrozenView(null);

    // A click inside the clip window is a request to preview that moment, not a nudge of the
    // clip. The selection overlay covers the whole window, so without this the only clickable
    // part of the track is the dimmed material the clip excludes.
    if (drag.kind === "region" && !drag.moved) {
      onScrub(Math.round(clampPlayhead(clientXToMs(event.clientX))));
      return;
    }

    // Moving the playhead changes no document state, so it must not write a version — only a
    // trim gesture commits.
    if (drag.kind !== "playhead") onCommitTrim();
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

  /** Arrow-key nudges commit when the key is released, so a held key is still one save. */
  const handleKeyUp = () => onCommitTrim();

  const handlePlayheadKeyDown = (event: React.KeyboardEvent) => {
    const dir = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (dir === 0) return;
    event.preventDefault();
    const delta = dir * (event.shiftKey ? NUDGE_LARGE_MS : NUDGE_MS);
    onScrub(Math.round(clampPlayhead(currentMs + delta)));
  };

  const startPct = msToPct(startMs);
  const endPct = msToPct(endMs);
  const playheadVisible = currentMs >= view.start && currentMs <= view.end;
  const clip = { startMs, endMs };

  return (
    <section
      aria-label="Timeline"
      className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Scissors size={18} className="text-teal-800" aria-hidden="true" />
          <h2 className="font-semibold">Timeline</h2>
        </div>
        <p className="text-xs font-medium text-stone-600">
          {formatClock(startMs)} – {formatClock(endMs)}
          <span className="text-stone-400"> · {formatClock(endMs - startMs)} long</span>
        </p>
      </div>
      <p className="mt-2 text-xs text-stone-500">
        Drag the handles on the Video row to set where the clip starts and ends, or drag the
        middle to move the whole clip. Drag the red marker, or click anywhere on the rows, to
        preview a spot. Handles snap to the nearest spoken word. Zoom shows more or less of the
        source around the clip; it never changes where the clip may start or end.
      </p>

      {/* The controls row, over the rows' own column so it lines up with them. */}
      <div className="mt-3 grid grid-cols-[3.5rem_1fr] gap-x-3">
        <span />
        {/*
          The transport is centred between two equal flexible sides. On a phone the two together
          are wider than the column, so the zoom drops to a line of its own rather than pushing the
          page wider than the screen — which zooms the whole page out and moves every target.
        */}
        <div className="flex flex-wrap items-center gap-y-2">
          <span className="hidden sm:block sm:flex-1" />
          <div className="mx-auto">{transport}</div>
          <div
            role="group"
            aria-label="Timeline zoom"
            className="flex w-full items-center justify-end gap-1 sm:w-auto sm:flex-1"
          >
            <ZoomButton
              label="Zoom out"
              disabled={zoom <= TIMELINE_ZOOM_MIN}
              onClick={() => onZoomChange(stepTimelineZoom(zoom, "out"))}
            >
              <ZoomOut size={16} aria-hidden="true" />
            </ZoomButton>
            <span
              data-testid="timeline-zoom"
              className="w-12 text-center font-mono text-xs tabular-nums text-stone-600"
            >
              {formatZoom(zoom)}
            </span>
            <ZoomButton
              label="Zoom in"
              disabled={zoom >= TIMELINE_ZOOM_MAX}
              onClick={() => onZoomChange(stepTimelineZoom(zoom, "in"))}
            >
              <ZoomIn size={16} aria-hidden="true" />
            </ZoomButton>
            <ZoomButton
              label="Reset timeline zoom"
              disabled={zoom === 1}
              onClick={() => onZoomChange(1)}
            >
              <Maximize size={16} aria-hidden="true" />
            </ZoomButton>
          </div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-[3.5rem_1fr] gap-x-3">
        {/* Labels, stacked to the same heights as the rows beside them. Each selects its row. */}
        <div className="text-xs font-medium text-stone-600">
          <div className={RULER_CLASS} />
          <RowLabel
            track="title"
            className={TITLE_ROW_CLASS}
            active={activeTrack === "title"}
            onSelect={onSelectTrack}
          >
            Title
          </RowLabel>
          <RowLabel
            track="video"
            className={VIDEO_ROW_CLASS}
            active={activeTrack === "video"}
            onSelect={onSelectTrack}
          >
            Video
          </RowLabel>
          <RowLabel
            track="audio"
            className={AUDIO_ROW_CLASS}
            active={activeTrack === "audio"}
            onSelect={onSelectTrack}
          >
            Audio
          </RowLabel>
        </div>

        {/*
          The surface: one set of pointer handlers, one pixel↔time scale for every row.

          Selecting happens in the capture phase, so a press anywhere on a row selects it — a
          title handle included, before the Title row stops that gesture propagating. Selecting
          changes nothing in the document: it is which settings are open, and no more.
        */}
        <div
          ref={trackRef}
          onPointerDownCapture={(event) => {
            const track = readTrack(event.target);
            if (track) onSelectTrack(track);
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="relative touch-none select-none"
        >
          {/*
            The ruler: the playhead's own strip, above every row. The line the playhead draws
            spans the rows, but only the knob here takes a pointer — the two are separate elements
            on purpose.

            The playhead sits at the clip start whenever the editor opens, and at the clip end
            after "Go to end", and a trim handle sits at each of those points too. When both
            claimed the same pixels the handle — deliberately stacked on top, because trimming is
            this component's primary control — swallowed every press meant for the playhead.
            Giving the knob a strip the handles do not reach settles it: handles own the Video
            row, the knob owns this strip, and neither can take a gesture aimed at the other.

            The target is 44x44 — the smallest thing a finger reliably hits — while the circle it
            draws stays 16x16.
          */}
          <div className={`relative ${RULER_CLASS}`}>
            {playheadVisible ? (
              <div
                data-trim="playhead"
                role="slider"
                tabIndex={0}
                aria-label="Playhead"
                aria-valuemin={Math.round(startMs)}
                aria-valuemax={Math.round(endMs)}
                aria-valuenow={Math.round(currentMs)}
                aria-valuetext={formatClock(currentMs)}
                onKeyDown={handlePlayheadKeyDown}
                className="absolute bottom-0 z-10 flex h-11 w-11 -translate-x-1/2 cursor-ew-resize touch-none items-end justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                style={{ left: `${msToPct(currentMs)}%` }}
              >
                <span className="pointer-events-none h-4 w-4 rounded-full border-2 border-white bg-red-500 shadow" />
              </div>
            ) : null}
          </div>

          <div
            className={`relative ${TITLE_ROW_CLASS} ${rowRing(activeTrack === "title")}`}
            data-track="title"
          >
            <TitleTrack
              title={title.banner}
              clip={clip}
              view={view}
              onChange={title.onChange}
              onCommit={title.onCommit}
              onAdd={title.onAdd}
            />
          </div>

          <div
            className={`relative ${VIDEO_ROW_CLASS} rounded-md bg-stone-100 ${rowRing(activeTrack === "video")}`}
            data-track="video"
            role="group"
            aria-label="Clip trim timeline"
          >
            {/* The source's own frames, under everything else the row draws. */}
            <VideoFrames
              sourceVideoUrl={sourceVideoUrl}
              view={view}
              settled={frozenView === null}
              focusMs={(startMs + endMs) / 2}
            />
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
              className="absolute inset-y-0 cursor-grab border-y-2 border-teal-500 bg-teal-500/15 active:cursor-grabbing"
              style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
              aria-hidden="true"
            />

            <TrimHandle
              kind="start"
              pct={startPct}
              valueNow={startMs}
              valueMax={sourceDurationMs}
              valueLabel={formatClock(startMs)}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
            />
            <TrimHandle
              kind="end"
              pct={endPct}
              valueNow={endMs}
              valueMax={sourceDurationMs}
              valueLabel={formatClock(endMs)}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
            />
          </div>

          <div
            className={`relative ${AUDIO_ROW_CLASS} ${rowRing(activeTrack === "audio")}`}
            data-track="audio"
          >
            <AudioTrack
              bars={audioBars}
              source={audioPeaks ? "audio" : "transcript"}
              clipStartPct={startPct}
              clipEndPct={endPct}
            />
          </div>

          {/* The playhead's line, down through every row from the knob's strip. */}
          {playheadVisible ? (
            <div
              className="pointer-events-none absolute bottom-0 top-11 z-10 -ml-px w-0.5 bg-red-500"
              style={{ left: `${msToPct(currentMs)}%` }}
              aria-hidden="true"
            />
          ) : null}
        </div>
      </div>

      <div className="mt-1 grid grid-cols-[3.5rem_1fr] gap-x-3">
        <span />
        <div
          data-testid="timeline-window"
          data-start={Math.round(view.start)}
          data-end={Math.round(view.end)}
          className="flex justify-between text-[10px] text-stone-400"
        >
          <span>{formatClock(view.start)}</span>
          <span>{formatClock(view.end)}</span>
        </div>
      </div>
    </section>
  );
}

/** The selected row's outline. Inside the row's own box, so no row's size or place changes. */
function rowRing(active: boolean): string {
  return active ? "rounded-md ring-2 ring-inset ring-teal-500" : "";
}

function RowLabel({
  track,
  className,
  active,
  onSelect,
  children,
}: {
  track: TimelineTrack;
  className: string;
  active: boolean;
  onSelect: (track: TimelineTrack) => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex items-center ${className}`}>
      <button
        type="button"
        data-testid={`track-select-${track}`}
        aria-pressed={active}
        onClick={() => onSelect(track)}
        className={`w-full rounded-md border px-2 py-1 text-left ${
          active
            ? "border-teal-700 bg-teal-700 text-white"
            : "border-stone-300 text-stone-700 hover:bg-stone-50"
        }`}
      >
        {children}
      </button>
    </div>
  );
}

function ZoomButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-md border border-stone-300 p-1.5 text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function TrimHandle({
  kind,
  pct,
  valueNow,
  valueMax,
  valueLabel,
  onKeyDown,
  onKeyUp,
}: {
  kind: "start" | "end";
  pct: number;
  valueNow: number;
  valueMax: number;
  valueLabel: string;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onKeyUp: () => void;
}) {
  return (
    <div
      data-trim={kind}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      role="slider"
      tabIndex={0}
      aria-label={kind === "start" ? "Clip start" : "Clip end"}
      aria-valuemin={0}
      aria-valuemax={Math.round(valueMax)}
      aria-valuenow={Math.round(valueNow)}
      aria-valuetext={valueLabel}
      className="absolute inset-y-0 z-20 flex w-4 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
      style={{ left: `${pct}%` }}
    >
      <div className="pointer-events-none h-full w-1.5 rounded bg-teal-700 shadow" />
    </div>
  );
}
