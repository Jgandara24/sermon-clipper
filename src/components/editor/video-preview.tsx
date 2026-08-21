"use client";

import {
  ChevronFirst,
  ChevronLast,
  Maximize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  CANVAS_VIEWPORT_RESET,
  canvasTransform,
  isViewportReset,
  panBy,
  pinchViewport,
  touchDistance,
  touchMidpoint,
  zoomPercent,
  type CanvasPoint,
  type CanvasRect,
  type CanvasViewport,
} from "@/lib/editor/canvas";
import {
  clampToClip,
  msToTimecode,
  playbackActionForTime,
  seekByMs,
  SKIP_STEP_MS,
} from "@/lib/editor/playback";
import { resolveActiveWord } from "@/lib/editor/active-word";
import { popScaleAt } from "@/lib/editor/caption-animation";
import { applyTextCase } from "@/lib/editor/text-case";
import {
  applyCaptionTextOverrides,
  buildCaptionLines,
  exclusiveLineSpans,
} from "@/lib/editor/caption-lines";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import type { EditorState } from "@/lib/editor/types";
import type { EditorWordWithDeletion } from "@/lib/editor/words";
import type { EditorBrandTemplate } from "@/components/editor/brand-template-panel";
import { CanvasObject, type CanvasObjectGesture } from "@/components/editor/canvas-object";

/** Matches the schema's bounds on captions.overrides.sizePx. */
const CAPTION_MIN_SIZE_PX = 16;
const CAPTION_MAX_SIZE_PX = 160;

/**
 * Where a caption sits before anyone has dragged it, so the object has somewhere to be. These
 * mirror the CSS the caption used to be laid out with; the moment it is dragged the document
 * carries an exact point and the preview and the burn-in agree on it.
 */
function defaultCaptionPoint(position: "top" | "middle" | "bottom"): CanvasPoint {
  if (position === "top") return { xPct: 0.5, yPct: 0.1 };
  if (position === "middle") return { xPct: 0.5, yPct: 0.45 };
  return { xPct: 0.5, yPct: 0.86 };
}

export function VideoPreview({
  sourceVideoUrl,
  state,
  words,
  showSafeZones,
  brandTemplate,
  onCurrentMsChange,
  onCaptionMove,
  onCaptionResize,
  onCaptionCommit,
  seek,
}: {
  sourceVideoUrl: string;
  state: EditorState;
  words: EditorWordWithDeletion[];
  showSafeZones: boolean;
  brandTemplate: EditorBrandTemplate | null;
  /** Reports playback position so the trim timeline can draw a synced playhead. */
  onCurrentMsChange?: (ms: number) => void;
  /** A frame of a caption drag. Mid-interaction: instant preview, coalesced save. */
  onCaptionMove?: (point: CanvasPoint) => void;
  /** A frame of a caption corner-resize. */
  onCaptionResize?: (sizePx: number) => void;
  /** The drag or resize ended: write it and close its undo entry. */
  onCaptionCommit?: (gesture: CanvasObjectGesture) => void;
  /** External seek request (from clicking/dragging the timeline). Bump `token` to re-seek. */
  seek?: { ms: number; token: number } | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [currentMs, setCurrentMsState] = useState(state.source.startMs);
  const [isPlaying, setIsPlaying] = useState(false);
  const seekedRef = useRef(false);
  /** A position chosen before the video could accept it; applied once metadata arrives. */
  const pendingSeekRef = useRef<number | null>(null);

  // Selection and viewport are view state. Neither is ever written to the document — that is the
  // whole point of the canvas: how you are looking at the frame cannot change what is exported.
  const [captionSelected, setCaptionSelected] = useState(false);
  const [showCentreGuide, setShowCentreGuide] = useState(false);
  const [viewport, setViewport] = useState<CanvasViewport>(CANVAS_VIEWPORT_RESET);

  const setCurrentMs = (ms: number) => {
    setCurrentMsState(ms);
    onCurrentMsChange?.(ms);
  };

  const activeWords = words.filter((word) => !word.effectiveDeleted);
  const captionLines = applyCaptionTextOverrides(
    buildCaptionLines(
      activeWords.map((word) => ({
        id: word.id,
        word: word.word,
        startMs: word.startMs,
        endMs: word.endMs,
      })),
    ),
    state.captions.textOverrides,
  );

  const style = resolveCaptionStyle(state.captions.presetId, state.captions.overrides);
  // The same spans the burn-in uses. Only a highlighting preset needs one line on screen at a
  // time; every other preset keeps the spans the line builder produced, unchanged.
  const spannedLines = style.activeWordHighlight
    ? exclusiveLineSpans(captionLines)
    : captionLines;
  const currentLine = spannedLines.find(
    (line) => currentMs >= line.startMs && currentMs < line.endMs,
  );
  const captionPoint = style.box ?? defaultCaptionPoint(style.position);
  // One resolver, shared with the burn-in: the word lit here is the word lit in the file. Only a
  // preset that highlights has an active word at all — Clean and the retired presets render the
  // line whole, exactly as they always did.
  const activeWord =
    currentLine && style.activeWordHighlight
      ? resolveActiveWord(currentLine.words, currentMs)
      : null;
  // A retyped line no longer corresponds to its words, so there is nothing to highlight.
  const captionIsRetyped =
    currentLine !== undefined &&
    currentLine.words.map((word) => word.word).join(" ") !== currentLine.text;

  useEffect(() => {
    seekedRef.current = false;
  }, [state.source.startMs]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    function applyInitialPosition() {
      if (!video) return;
      // A position the user already chose wins over the default. Without this, a transport
      // button or a timeline click pressed before the video finished loading was silently
      // undone the moment metadata arrived.
      const pending = pendingSeekRef.current;
      if (pending !== null) {
        video.currentTime = pending / 1000;
        pendingSeekRef.current = null;
        seekedRef.current = true;
        return;
      }
      if (!seekedRef.current) {
        video.currentTime = state.source.startMs / 1000;
        seekedRef.current = true;
      }
    }

    video.addEventListener("loadedmetadata", applyInitialPosition);
    if (video.readyState >= 1) applyInitialPosition();
    return () => video.removeEventListener("loadedmetadata", applyInitialPosition);
  }, [state.source.startMs]);

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    // A seek is not instantaneous, and the element keeps reporting the position it is leaving
    // until it lands. Acting on those would drag the playhead back to where the user just was.
    if (video.seeking) return;

    const action = playbackActionForTime({
      ms: video.currentTime * 1000,
      startMs: state.source.startMs,
      endMs: state.source.endMs,
      deletedRanges: words.filter((word) => word.effectiveDeleted),
    });

    if (action.kind === "stop") {
      // Stop at the clip end. It does not loop: the last frame the export contains is worth
      // looking at, and a preview that restarts hides it.
      video.pause();
      video.currentTime = action.atMs / 1000;
      setCurrentMs(action.atMs);
      return;
    }
    if (action.kind === "skip") {
      video.currentTime = action.toMs / 1000;
      return;
    }
    setCurrentMs(action.atMs);
  }

  const seekTo = useCallback(
    (ms: number) => {
      const video = videoRef.current;
      const target = clampToClip(ms, state.source.startMs, state.source.endMs);
      // The user has chosen a position: the default seek-to-start must not overwrite it.
      seekedRef.current = true;
      if (video) {
        if (video.readyState >= 1) {
          video.currentTime = target / 1000;
        } else {
          pendingSeekRef.current = target;
        }
      }
      setCurrentMsState(target);
      onCurrentMsChange?.(target);
    },
    // setCurrentMs is redefined each render; the bounds and the reporter are what matter here.
    [state.source.startMs, state.source.endMs, onCurrentMsChange],
  );

  // External seek: clicking or dragging the timeline drives the preview frame. The token is
  // what marks a fresh request, so repeated seeks to the same millisecond still fire.
  const appliedSeekTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!seek || seek.token === appliedSeekTokenRef.current) return;
    appliedSeekTokenRef.current = seek.token;
    seekTo(seek.ms);
  }, [seek, seekTo]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // Replaying from the end starts over rather than sitting on the last frame.
      if (currentMs >= state.source.endMs - 50) seekTo(state.source.startMs);
      void video.play();
    } else {
      video.pause();
    }
  }

  function skipBy(deltaMs: number) {
    seekTo(seekByMs(currentMs, deltaMs, state.source.startMs, state.source.endMs));
  }

  const readCanvasRect = useCallback((): CanvasRect | null => {
    const element = canvasRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, []);

  // --- Two-finger canvas gestures -------------------------------------------------------------
  // Pinch to zoom and, once zoomed, two fingers to pan. Tracked in a ref because a pointer frame
  // must not re-render anything but the viewport itself.
  const pinchRef = useRef<{
    pointers: Map<number, { clientX: number; clientY: number }>;
    startDistancePx: number;
    startMidpoint: { clientX: number; clientY: number };
    startViewport: CanvasViewport;
  }>({
    pointers: new Map(),
    startDistancePx: 0,
    startMidpoint: { clientX: 0, clientY: 0 },
    startViewport: CANVAS_VIEWPORT_RESET,
  });

  function handleCanvasPointerDown(event: React.PointerEvent) {
    const pinch = pinchRef.current;
    pinch.pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (pinch.pointers.size !== 2) return;

    const [a, b] = [...pinch.pointers.values()];
    pinch.startDistancePx = touchDistance(a, b);
    pinch.startMidpoint = touchMidpoint(a, b);
    pinch.startViewport = viewport;
  }

  function handleCanvasPointerMove(event: React.PointerEvent) {
    const pinch = pinchRef.current;
    if (!pinch.pointers.has(event.pointerId)) return;
    pinch.pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (pinch.pointers.size !== 2) return;

    event.preventDefault();
    const [a, b] = [...pinch.pointers.values()];
    const rect = readCanvasRect();
    const zoomed = pinchViewport({
      startViewport: pinch.startViewport,
      startDistancePx: pinch.startDistancePx,
      currentDistancePx: touchDistance(a, b),
    });

    // The same two fingers pan: how far their midpoint travelled is how far the frame moves.
    const midpoint = touchMidpoint(a, b);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      setViewport(zoomed);
      return;
    }
    setViewport(
      panBy(
        zoomed,
        (midpoint.clientX - pinch.startMidpoint.clientX) / rect.width / zoomed.zoom,
        (midpoint.clientY - pinch.startMidpoint.clientY) / rect.height / zoomed.zoom,
      ),
    );
  }

  function handleCanvasPointerUp(event: React.PointerEvent) {
    pinchRef.current.pointers.delete(event.pointerId);
  }

  function resetZoom() {
    setViewport(CANVAS_VIEWPORT_RESET);
  }

  /** A press on the frame itself, not on an object: the selection is over. */
  function clearSelection() {
    setCaptionSelected(false);
    setShowCentreGuide(false);
  }

  // A centred caption occupies the middle of the frame; the play button must not cover it.
  const captionIsCentred = captionPoint.yPct > 0.3 && captionPoint.yPct < 0.65 && currentLine !== undefined;
  const cropCenterX = (state.layout.crop.x + state.layout.crop.w / 2) * 100;
  const cropCenterY = (state.layout.crop.y + state.layout.crop.h / 2) * 100;
  const zoom =
    state.layout.mode === "manual" ? 1 / Math.max(state.layout.crop.w, state.layout.crop.h, 0.2) : 1;
  const atRest = isViewportReset(viewport);

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-black shadow-sm">
      <div
        ref={canvasRef}
        data-testid="editor-canvas"
        onPointerDown={handleCanvasPointerDown}
        onPointerMove={handleCanvasPointerMove}
        onPointerUp={handleCanvasPointerUp}
        onPointerCancel={handleCanvasPointerUp}
        className="relative aspect-[9/16] w-full touch-none overflow-hidden bg-black"
      >
        {/*
          Everything the frame contains is drawn inside this one transform, so zooming moves the
          view and nothing else. No document value is read from or written to it.
        */}
        <div
          data-testid="canvas-content"
          className="absolute inset-0"
          style={{ transform: canvasTransform(viewport), transformOrigin: "center" }}
        >
          <video
            ref={videoRef}
            src={sourceVideoUrl}
            onTimeUpdate={handleTimeUpdate}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onClick={() => {
              clearSelection();
              togglePlay();
            }}
            playsInline
            className="absolute inset-0 h-full w-full cursor-pointer object-cover"
            style={{
              objectPosition: `${cropCenterX}% ${cropCenterY}%`,
              transform: zoom !== 1 ? `scale(${zoom})` : undefined,
            }}
          />

          {/*
            Guides. Every one of them is a DOM element in the editor and nothing else — the export
            is burnt in from an ASS subtitle file that has no notion of them, so there is no path
            by which a guide could reach a rendered video.
          */}
          {showSafeZones ? (
            <div data-testid="safe-zones" className="pointer-events-none absolute inset-0">
              {/* The area every platform keeps clear of its own chrome. */}
              <div className="absolute inset-x-[6%] top-[6%] bottom-[12%] border border-dashed border-white/60" />
              {/* Where a feed's caption and action rail sit over the video. */}
              <div className="absolute inset-x-0 bottom-0 h-[12%] bg-red-500/10" />
              <div className="absolute inset-x-0 top-0 h-[6%] bg-red-500/10" />
            </div>
          ) : null}

          {showCentreGuide ? (
            <div
              data-testid="centre-guide"
              className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-teal-300"
            />
          ) : null}

          {/*
            The large play affordance only exists while paused, and it steps out of the way of a
            centred caption rather than sitting on top of the words being reviewed.
          */}
          {!isPlaying ? (
            <button
              type="button"
              onClick={() => {
                clearSelection();
                togglePlay();
              }}
              aria-label="Play"
              className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/55 p-4 text-white transition hover:bg-black/70"
              style={{ top: captionIsCentred ? "28%" : "50%" }}
            >
              <Play size={28} aria-hidden="true" />
            </button>
          ) : null}

          {currentLine ? (
            <CanvasObject
              label="Captions"
              point={captionPoint}
              sizePx={style.sizePx}
              minSizePx={CAPTION_MIN_SIZE_PX}
              maxSizePx={CAPTION_MAX_SIZE_PX}
              selected={captionSelected}
              viewport={viewport}
              rectRef={readCanvasRect}
              onSelect={() => setCaptionSelected(true)}
              onMove={(point, snapped) => {
                setShowCentreGuide(snapped);
                onCaptionMove?.(point);
              }}
              onResize={(sizePx) => onCaptionResize?.(sizePx)}
              onCommit={(gesture) => {
                setShowCentreGuide(false);
                onCaptionCommit?.(gesture);
              }}
            >
              <span
                data-testid="caption-line"
                className="block whitespace-nowrap rounded px-2 py-1 text-center"
                style={{
                  fontFamily: style.fontFamily,
                  fontSize: `${style.sizePx * 0.4}px`,
                  fontWeight: style.weight,
                  color: style.textColor,
                  // No text-transform: the preview lays out the same string the burn-in does, so
                  // the two cannot disagree — and CSS cannot express Sentence case or Title Case.
                  backgroundColor: style.background === "pill" ? "rgba(0,0,0,0.55)" : "transparent",
                  textShadow: style.shadow ? "0 2px 4px rgba(0,0,0,0.8)" : undefined,
                  WebkitTextStroke:
                    style.strokePx > 0 ? `${style.strokePx * 0.3}px ${style.strokeColor}` : undefined,
                }}
              >
                {/*
                  Rest spacing: no width is reserved for the pop, so a line with nothing active is
                  laid out exactly like one with an active word. The active word scales on the
                  shared curve and its neighbours do not move, which is why it can overlap them
                  slightly at large sizes until Slice 8 shifts them aside.
                */}
                {captionIsRetyped || !style.activeWordHighlight
                  ? applyTextCase(currentLine.text, style.textCase)
                  : currentLine.words.map((word, index) => (
                      <Fragment key={word.id}>
                        {/* The separator sits outside the word, so the highlight covers the
                            word and not the space in front of it. */}
                        {index > 0 ? " " : ""}
                        <span
                          data-testid="caption-word"
                          data-active={word.id === activeWord?.id ? "true" : "false"}
                          style={
                            word.id === activeWord?.id
                              ? {
                                  color: style.highlightColor,
                                  // Same curve the burn-in evaluates, from the same module.
                                  // `display` because a span cannot be scaled while inline.
                                  display: "inline-block",
                                  transform: `scale(${popScaleAt(currentMs - word.startMs)})`,
                                }
                              : undefined
                          }
                        >
                          {applyTextCase(word.word, style.textCase)}
                        </span>
                      </Fragment>
                    ))}
              </span>
            </CanvasObject>
          ) : null}

          {brandTemplate ? (
            <div className="pointer-events-none absolute left-[6%] right-[6%] bottom-[22%] flex justify-start">
              <div
                className="max-w-[88%] rounded-md px-3 py-2 text-white shadow-lg"
                style={{ backgroundColor: `${brandTemplate.primaryColor}E6` }}
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: brandTemplate.accentColor }}>
                  {brandTemplate.lowerThird.headline || brandTemplate.churchName}
                </p>
                <p className="mt-0.5 text-[10px] text-white/90">
                  {brandTemplate.lowerThird.subhead || brandTemplate.speakerName || "Sermon clip"}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 bg-stone-900 px-3 py-2 text-white">
        <div className="flex items-center gap-1">
          <TransportButton label="Go to start" onClick={() => seekTo(state.source.startMs)}>
            <ChevronFirst size={16} aria-hidden="true" />
          </TransportButton>
          <TransportButton label="Back 3 seconds" onClick={() => skipBy(-SKIP_STEP_MS)}>
            <RotateCcw size={16} aria-hidden="true" />
          </TransportButton>
          <TransportButton label={isPlaying ? "Pause" : "Play clip"} onClick={togglePlay}>
            {isPlaying ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          </TransportButton>
          <TransportButton label="Forward 3 seconds" onClick={() => skipBy(SKIP_STEP_MS)}>
            <RotateCw size={16} aria-hidden="true" />
          </TransportButton>
          {/* Seeks to the clip end and stays there, rather than restarting the clip. */}
          <TransportButton label="Go to end" onClick={() => seekTo(state.source.endMs)}>
            <ChevronLast size={16} aria-hidden="true" />
          </TransportButton>
        </div>
        <div className="flex items-center gap-2">
          {/* Canvas zoom only. The trim timeline has its own window and is not touched by this. */}
          <span data-testid="canvas-zoom" className="font-mono text-xs tabular-nums text-white/70">
            {zoomPercent(viewport)}%
          </span>
          <TransportButton label="Reset zoom to 100%" onClick={resetZoom} disabled={atRest}>
            <Maximize size={16} aria-hidden="true" />
          </TransportButton>
          <p className="font-mono text-xs tabular-nums text-white/80">
            <span data-testid="playback-position">
              {msToTimecode(currentMs - state.source.startMs)}
            </span>
            {" / "}
            {msToTimecode(state.source.endMs - state.source.startMs)}
          </p>
        </div>
      </div>
    </div>
  );
}

function TransportButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-md p-2 text-white/90 hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
