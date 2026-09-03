"use client";

import { Maximize, Play } from "lucide-react";
import { Fragment, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
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
} from "@/lib/editor/playback";
import { captionActivationAt } from "@/lib/editor/caption-timeline";
import { POP, popScaleAt, popShiftProgressAt } from "@/lib/editor/caption-animation";
import { applyTextCase } from "@/lib/editor/text-case";
import { applyCaptionTextOverrides, buildCaptionLines } from "@/lib/editor/caption-lines";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import type { EditorState } from "@/lib/editor/types";
import type { EditorWordWithDeletion } from "@/lib/editor/words";
import type { EditorBrandTemplate } from "@/components/editor/brand-template-panel";
import type { PreviewTransport } from "@/components/editor/transport-controls";
import { CanvasObject, type CanvasObjectGesture } from "@/components/editor/canvas-object";
import {
  captionMaxWidthPx,
  captionRestCentre,
  lowerThirdGeometry,
  safeAreaGuideGeometry,
} from "@/lib/editor/social-safe-area";
import { readTitleBanner, TITLE_BANNER_FONT_FAMILY } from "@/lib/editor/title-banner";
import { layOutTitleBanner } from "@/lib/editor/title-layout";
import {
  CAPTION_BOLD_WEIGHT,
  CAPTION_REGULAR_WEIGHT,
  isBoldCaptionWeight,
  resolveCaptionFace,
} from "@/lib/editor/caption-face";
import { layOutCaptionRows } from "@/lib/editor/caption-layout";
import { useCaptionTextMeasurer } from "@/components/editor/use-text-measurer";

/** Matches the schema's bounds on captions.overrides.sizePx. */
/**
 * The frame the burn-in positions in. The preview lays the caption out in these coordinates and
 * scales the result to whatever width it is actually drawn at, so both renderers answer the same
 * question and only the last step differs.
 */
const FRAME_WIDTH = 1080;
const FRAME_HEIGHT = 1920;
/** Left and right margins the burn-in's style line declares. The usable row width is what is left. */
/**
 * Used only before the canvas has been measured, for the one frame between mount and the first
 * resize observation.
 */
const FALLBACK_PREVIEW_SCALE = 318 / FRAME_WIDTH;

const CAPTION_MIN_SIZE_PX = 16;
const TITLE_MIN_SIZE_PX = 16;
const TITLE_MAX_SIZE_PX = 200;
const CAPTION_MAX_SIZE_PX = 160;


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
  onTitleMove,
  onTitleResize,
  onTitleCommit,
  seek,
  transportRef,
  onPlayingChange,
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
  /** A frame of a title drag. Writes a custom anchor: dragging is choosing a place. */
  onTitleMove?: (point: CanvasPoint) => void;
  /** A frame of a title corner-resize, which changes its type size. */
  onTitleResize?: (sizePx: number) => void;
  onTitleCommit?: (gesture: CanvasObjectGesture) => void;
  /** External seek request (from clicking/dragging the timeline). Bump `token` to re-seek. */
  seek?: { ms: number; token: number } | null;
  /** Filled after mounting with what the transport above the timeline may ask of this preview. */
  transportRef?: React.Ref<PreviewTransport>;
  /** Reports the element's own play and pause, so the transport's button can show which is next. */
  onPlayingChange?: (playing: boolean) => void;
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
  const [titleSelected, setTitleSelected] = useState(false);
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
  // One decision about what is on screen, shared with the burn-in: which line, which words, and
  // which stretch. Deciding it here as well as there is what let the file show a caption the
  // browser did not, three milliseconds either side of a line.
  const activation = captionActivationAt(captionLines, currentMs, style.activeWordHighlight);
  const currentLine = activation?.line;
  const currentWords = activation?.words ?? [];
  const activeWordId = activation?.activeWordId ?? null;
  // Nothing left to lay out word by word once the text is empty or the preset renders it whole.
  // How much of a frame pixel a preview pixel is, measured rather than assumed.
  //
  // The caption size used to be a flat 0.4 of the style's own size, which quietly asserted the
  // canvas was 432px wide. It is not — at the editor's usual width it is about 318px — so the
  // preview drew captions around a third larger, relative to the frame, than the exported file
  // does. Positioning words in frame coordinates makes that assumption load-bearing, so the scale
  // is now taken from the element.
  const [canvasWidthPx, setCanvasWidthPx] = useState(0);
  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width ?? 0;
      if (width > 0) setCanvasWidthPx(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const previewScale = canvasWidthPx > 0 ? canvasWidthPx / FRAME_WIDTH : FALLBACK_PREVIEW_SCALE;

  const captionIsRetyped = currentWords.length === 0;
  // Where a caption sits before anyone has dragged it, so the object has somewhere to be. The
  // moment it is dragged the document carries an exact point instead.
  const captionPoint = style.box ?? captionRestCentre(style.position);
  const guide = safeAreaGuideGeometry();
  const lowerThirdBand = lowerThirdGeometry();

  // The browser half of the measured layout. Until the bundled face has loaded this reports
  // nothing, and the caption keeps the CSS flow it has always used — a measurement taken before
  // the file arrives is the fallback's metrics, and it looks perfectly valid.
  const measurer = useCaptionTextMeasurer(style);

  // The title overlay. Its times are on the source timeline, which is the timeline this preview
  // plays on — the burn-in remaps them onto the cut output instead, and neither side does the
  // other's arithmetic.
  const titleBanner = readTitleBanner(state.overlays);
  const titleMeasurer = useCaptionTextMeasurer(
    titleBanner ?? { fontFamily: TITLE_BANNER_FONT_FAMILY, sizePx: 64, weight: 700 },
  );
  const titleLayout =
    titleBanner && titleMeasurer.ready
      ? layOutTitleBanner({
          title: titleBanner,
          videoWidth: FRAME_WIDTH,
          videoHeight: FRAME_HEIGHT,
          measure: titleMeasurer.measure,
          spaceWidth: titleMeasurer.spaceWidth,
        })
      : null;
  const titleIsOnScreen =
    titleBanner !== null &&
    titleLayout !== null &&
    currentMs >= titleBanner.startMs &&
    currentMs < titleBanner.endMs;
  const measuredRows =
    measurer.ready && style.activeWordHighlight && !captionIsRetyped
      ? layOutCaptionRows({
          words: currentWords.map((word) => ({
            id: word.id,
            text: applyTextCase(word.word, style.textCase),
          })),
          measure: measurer.measure,
          spaceWidth: measurer.spaceWidth,
          activeWordId,
          peakScale: POP.peakScale,
          maxWidth: captionMaxWidthPx(FRAME_WIDTH),
        })
      : null;

  const captionRowPitchPx = style.sizePx * previewScale;
  const captionBlockWidthPx = measuredRows
    ? Math.max(...measuredRows.rows.map((row) => row.restWidth)) * previewScale
    : 0;
  const captionBlockHeightPx = measuredRows ? measuredRows.rows.length * captionRowPitchPx : 0;
  /**
   * How far the block shifts so its anchor lands where the burn-in puts it.
   *
   * The canvas object centres whatever it holds on the caption's point, which is right for a
   * caption that was dragged there and for a middle-positioned one. A bottom-anchored caption is
   * different: the burn-in keeps its last row on the margin line and stacks further rows above, so
   * a second row must grow upward rather than push the first one up. A top-anchored one grows
   * downward for the same reason.
   */
  const captionRowsShiftPx = (() => {
    if (!measuredRows || style.box) return 0;
    const extra = ((measuredRows.rows.length - 1) / 2) * captionRowPitchPx;
    if (style.position === "top") return extra;
    if (style.position === "middle") return 0;
    return -extra;
  })();

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

  // The transport lives above the timeline's tracks; the video element stays here. This is the
  // whole of what it may ask, and each is the same function the preview's own bar used to call.
  useImperativeHandle(transportRef, () => ({ togglePlay, seekTo, skipBy }));

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
    setTitleSelected(false);
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
            onPlay={() => {
              setIsPlaying(true);
              onPlayingChange?.(true);
            }}
            onPause={() => {
              setIsPlaying(false);
              onPlayingChange?.(false);
            }}
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
              <div
                className="absolute border border-dashed border-white/60"
                style={{
                  left: guide.left,
                  right: guide.right,
                  top: guide.top,
                  bottom: guide.bottom,
                }}
              />
              {/* Where a feed's caption and action rail sit over the video. */}
              <div
                className="absolute inset-x-0 bottom-0 bg-red-500/10"
                style={{ height: guide.bottomBandHeight }}
              />
              <div
                className="absolute inset-x-0 top-0 bg-red-500/10"
                style={{ height: guide.topBandHeight }}
              />
            </div>
          ) : null}

          {showCentreGuide ? (
            <div
              data-testid="centre-guide"
              className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-teal-300"
            />
          ) : null}

          {/*
            The title. Every number here comes from `layOutTitleBanner`, the same call the burn-in
            makes — the box, the wrap, each line's centre, where the text is anchored. Nothing is
            laid out by CSS flow, because flow is the thing the ASS file cannot reproduce.
          */}
          {titleIsOnScreen && titleBanner && titleLayout ? (
            <CanvasObject
              label="Title"
              // The box's own centre, wherever the anchor put it, so dragging starts from where
              // the title is rather than from where it would be if it had been dragged before.
              point={{
                xPct: (titleLayout.box.x + titleLayout.box.width / 2) / FRAME_WIDTH,
                yPct: (titleLayout.box.y + titleLayout.box.height / 2) / FRAME_HEIGHT,
              }}
              sizePx={titleBanner.sizePx}
              minSizePx={TITLE_MIN_SIZE_PX}
              maxSizePx={TITLE_MAX_SIZE_PX}
              selected={titleSelected}
              viewport={viewport}
              rectRef={readCanvasRect}
              onSelect={() => setTitleSelected(true)}
              onMove={(point, snapped) => {
                setShowCentreGuide(snapped);
                onTitleMove?.(point);
              }}
              onResize={(sizePx) => onTitleResize?.(sizePx)}
              onCommit={(gesture) => {
                setShowCentreGuide(false);
                onTitleCommit?.(gesture);
              }}
            >
            {/*
              Laid out in flow, not positioned: the object around it is what places it, and two
              things placing one box is how a drag ends up fighting its own render.
            */}
            <div
              data-testid="title-banner"
              className="relative"
              style={{
                width: `${titleLayout.box.width * previewScale}px`,
                height: `${titleLayout.box.height * previewScale}px`,
                backgroundColor: titleBanner.backgroundColor,
                // Inside the box, exactly as the burn-in draws it, so a border does not widen the
                // width the member set.
                boxSizing: "border-box",
                border:
                  titleLayout.border.widthPx > 0
                    ? `${titleLayout.border.widthPx * previewScale}px solid ${titleLayout.border.color}`
                    : undefined,
                boxShadow: titleBanner.shadow
                  ? `${4 * previewScale}px ${4 * previewScale}px 0 rgba(0,0,0,0.5)`
                  : undefined,
              }}
            >
              {titleLayout.lines.map((line, index) => (
                <span
                  key={index}
                  data-testid="title-line"
                  className="absolute whitespace-pre"
                  style={{
                    left: `${(titleLayout.textX - titleLayout.box.x) * previewScale}px`,
                    top: `${(titleLayout.lineCentresY[index] - titleLayout.box.y) * previewScale}px`,
                    transform: `translate(${
                      titleBanner.align === "left"
                        ? "0"
                        : titleBanner.align === "right"
                          ? "-100%"
                          : "-50%"
                    }, -50%)`,
                    color: titleBanner.color,
                    fontFamily: `"${resolveCaptionFace(titleBanner).family}"`,
                    fontWeight: isBoldCaptionWeight(titleBanner.weight)
                      ? CAPTION_BOLD_WEIGHT
                      : CAPTION_REGULAR_WEIGHT,
                    // The em, not the size: an ASS font size is a height, and drawing at the
                    // number itself makes the preview about a sixth larger than the file.
                    fontSize: `${titleMeasurer.emPx * previewScale}px`,
                    lineHeight: 1,
                  }}
                >
                  {line}
                </span>
              ))}
            </div>
            </CanvasObject>
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
                  // The em the burn-in draws at, not the caption's nominal size. An ASS font
                  // size is a height, so a caption drawn at the number itself is about a sixth
                  // larger than the exported file's. Before the face has loaded there is nothing
                  // to ask, and the nominal size is the honest guess.
                  fontSize: `${(measurer.ready ? measurer.emPx : style.sizePx) * previewScale}px`,
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
                  slightly at large sizes until Slice 8b shifts them aside.
                */}
                {measuredRows ? (
                  // Positioned from the same layout the burn-in reads, in the same frame
                  // coordinates, so the two agree about where a word is rather than one flowing
                  // text and the other placing it.
                  <span
                    className="relative block"
                    style={{
                      width: `${captionBlockWidthPx}px`,
                      height: `${captionBlockHeightPx}px`,
                      transform: `translateY(${captionRowsShiftPx}px)`,
                    }}
                  >
                    {measuredRows.rows.map((row, rowIndex) =>
                      row.words.map((word) => {
                        const isActive = word.id === activeWordId;
                        // How far this word has moved aside. Straight within each segment of the
                        // subdivided motion, because that is all the burned-in file can express,
                        // and both sides must agree between boundaries as well as at them.
                        const shift =
                          isActive || !activation
                            ? 0
                            : (word.shiftedX - word.restX) *
                              popShiftProgressAt(
                                currentMs - activation.startMs,
                                activation.endMs - activation.startMs,
                              );
                        return (
                          <span
                            key={word.id}
                            data-testid="caption-word"
                            data-active={isActive ? "true" : "false"}
                            className="absolute whitespace-pre"
                            style={{
                              left: `${captionBlockWidthPx / 2 + (word.restX + shift) * previewScale}px`,
                              top: `${rowIndex * captionRowPitchPx + captionRowPitchPx / 2}px`,
                              // The word is centred on its own point, so the pop scales it about
                              // itself. The words beside it move; it does not.
                              transform: `translate(-50%, -50%) scale(${
                                isActive && activation
                                  ? popScaleAt(
                                      currentMs - activation.startMs,
                                      activation.endMs - activation.startMs,
                                    )
                                  : 1
                              })`,
                              ...(isActive ? { color: style.highlightColor } : null),
                            }}
                          >
                            {word.text}
                          </span>
                        );
                      }),
                    )}
                  </span>
                ) : captionIsRetyped || !style.activeWordHighlight ? (
                  applyTextCase(currentLine.text, style.textCase)
                ) : (
                  currentWords.map((word, index) => (
                    <Fragment key={word.id}>
                      {/* The separator sits outside the word, so the highlight covers the
                          word and not the space in front of it. */}
                      {index > 0 ? " " : ""}
                      <span
                        data-testid="caption-word"
                        data-active={word.id === activeWordId ? "true" : "false"}
                        style={{
                          // Every word is inline-block, not just the active one: a span that
                          // changes display changes the line's layout, and rest spacing has to
                          // be identical whether or not anything is active. A transform does
                          // not affect layout, so the pop moves nothing.
                          display: "inline-block",
                          ...(word.id === activeWordId && activation
                            ? {
                                color: style.highlightColor,
                                // Same curve the burn-in evaluates, on the same clock: elapsed
                                // into this activation, over this activation's own length.
                                transform: `scale(${popScaleAt(
                                  currentMs - activation!.startMs,
                                  activation!.endMs - activation!.startMs,
                                )})`,
                              }
                            : null),
                        }}
                      >
                        {applyTextCase(word.word, style.textCase)}
                      </span>
                    </Fragment>
                  ))
                )}
              </span>
            </CanvasObject>
          ) : null}

          {brandTemplate ? (
            <div
              className="pointer-events-none absolute flex justify-start"
              style={{
                left: lowerThirdBand.left,
                right: lowerThirdBand.right,
                bottom: lowerThirdBand.bottom,
              }}
            >
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

      {/*
        The transport — start, back, play, forward, end — lives above the timeline's tracks now
        (TransportControls), driving this preview through `transportRef`. What stays here is what
        belongs to the picture: where playback is, and how far the canvas is zoomed.
      */}
      <div className="flex items-center justify-between gap-2 bg-stone-900 px-3 py-2 text-white">
        <p className="font-mono text-xs tabular-nums text-white/80">
          <span data-testid="playback-position">
            {msToTimecode(currentMs - state.source.startMs)}
          </span>
          {" / "}
          {msToTimecode(state.source.endMs - state.source.startMs)}
        </p>
        <div className="flex items-center gap-2">
          {/* Canvas zoom only. The trim timeline has its own window and is not touched by this. */}
          <span data-testid="canvas-zoom" className="font-mono text-xs tabular-nums text-white/70">
            {zoomPercent(viewport)}%
          </span>
          <TransportButton label="Reset zoom to 100%" onClick={resetZoom} disabled={atRest}>
            <Maximize size={16} aria-hidden="true" />
          </TransportButton>
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
