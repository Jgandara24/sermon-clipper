"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyCaptionTextOverrides, buildCaptionLines } from "@/lib/editor/caption-lines";
import { wordScaleAt } from "@/lib/editor/caption-animation";
import { layoutCaptionLine } from "@/lib/editor/caption-layout";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import { safeAreaBounds, UNIVERSAL_SOCIAL_SAFE_AREA } from "@/lib/editor/social-safe-area";
import type { EditorState } from "@/lib/editor/types";
import type { EditorWordWithDeletion } from "@/lib/editor/words";
import type { EditorBrandTemplate } from "@/components/editor/brand-template-panel";
import { useTextMeasurer } from "@/components/editor/use-text-measurer";

// The caption stage is a fixed virtual 1080x1920 frame — the exact ASS PlayRes — scaled to
// fit the on-screen preview. Every caption coordinate here is the same number the burned-in
// render uses; parity is a transform, not a re-implementation.
const STAGE_WIDTH = 1080;
const STAGE_HEIGHT = 1920;

const SNAP_THRESHOLD = 1.5;

export type CaptionPlacement = {
  positionX: number;
  positionY: number;
};

export function VideoPreview({
  sourceVideoUrl,
  state,
  words,
  showSafeZones,
  brandTemplate,
  onCurrentMsChange,
  captionSelected = true,
  onCaptionSelectedChange,
  onCaptionPositionChange,
  seek,
  fillHeight = false,
}: {
  sourceVideoUrl: string;
  state: EditorState;
  words: EditorWordWithDeletion[];
  showSafeZones: boolean;
  brandTemplate: EditorBrandTemplate | null;
  /** Reports playback position so the trim timeline can draw a synced playhead. */
  onCurrentMsChange?: (ms: number) => void;
  captionSelected?: boolean;
  onCaptionSelectedChange?: (selected: boolean) => void;
  /** Caption object drag writes its center position (0-100) into the editor state. */
  onCaptionPositionChange?: (placement: CaptionPlacement) => void;
  /** External seek request (from clicking/dragging the timeline). Bump `token` to re-seek. */
  seek?: { ms: number; token: number } | null;
  fillHeight?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const [currentMs, setCurrentMsState] = useState(state.source.startMs);
  const [stageScale, setStageScale] = useState(0.2);
  const [dragPlacement, setDragPlacement] = useState<CaptionPlacement | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const seekedRef = useRef(false);
  const lastReportedRef = useRef(0);

  const setCurrentMs = useCallback(
    (ms: number) => {
      setCurrentMsState(ms);
      // The parent re-renders the whole editor on this callback; ~10Hz is plenty for the
      // timeline playhead while the caption pop animates at rAF rate locally.
      if (Math.abs(ms - lastReportedRef.current) >= 100) {
        lastReportedRef.current = ms;
        onCurrentMsChange?.(ms);
      }
    },
    [onCurrentMsChange],
  );

  const style = useMemo(
    () => resolveCaptionStyle(state.captions.presetId, state.captions.overrides),
    [state.captions.presetId, state.captions.overrides],
  );
  const { measure, ready: fontsReady } = useTextMeasurer(style.fontFamily, style.fontWeight);

  const captionLines = useMemo(() => {
    const activeWords = words.filter((word) => !word.effectiveDeleted);
    return applyCaptionTextOverrides(
      buildCaptionLines(
        activeWords.map((word) => ({
          id: word.id,
          word: word.word,
          startMs: word.startMs,
          endMs: Math.min(word.endMs, state.source.endMs),
        })),
        { maxWordsPerLine: style.maxWordsPerLine },
      ),
      state.captions.textOverrides,
    );
  }, [words, state.captions.textOverrides, state.source.endMs, style.maxWordsPerLine]);

  const currentLine = captionLines.find(
    (line) => currentMs >= line.startMs && currentMs < line.endMs,
  );

  const layout = useMemo(
    () =>
      currentLine
        ? layoutCaptionLine(currentLine, style, { width: STAGE_WIDTH, height: STAGE_HEIGHT }, measure)
        : null,
    [currentLine, style, measure],
  );

  // Scale the virtual 1080x1920 stage to the rendered preview size.
  useEffect(() => {
    const wrap = stageWrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setStageScale(width / STAGE_WIDTH);
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    seekedRef.current = false;
  }, [state.source.startMs]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    function seekToStart() {
      if (video && !seekedRef.current) {
        video.currentTime = state.source.startMs / 1000;
        seekedRef.current = true;
      }
    }

    video.addEventListener("loadedmetadata", seekToStart);
    if (video.readyState >= 1) seekToStart();
    return () => video.removeEventListener("loadedmetadata", seekToStart);
  }, [state.source.startMs]);

  // External seek: clicking/dragging the trim timeline drives the preview frame. Keyed on the
  // token so repeated seeks to the same ms still fire.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !seek) return;
    video.currentTime = seek.ms / 1000;
    setCurrentMsState(seek.ms);
    lastReportedRef.current = seek.ms;
    onCurrentMsChange?.(seek.ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek?.token]);

  // rAF playback clock: timeupdate fires at ~4-15Hz, far too coarse to animate a 90ms word
  // pop. While the video plays, sample currentTime every frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const tick = () => {
      if (!video.paused && !video.ended) {
        const ms = video.currentTime * 1000;
        if (ms >= state.source.endMs) {
          video.currentTime = state.source.startMs / 1000;
          setCurrentMs(state.source.startMs);
        } else {
          setCurrentMs(ms);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.source.startMs, state.source.endMs]);

  // P1.4/P1.5: playback is continuous — the preview keeps no "what survives" logic of its
  // own. timeupdate remains only as a fallback clock while paused-scrubbing natively.
  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video || !video.paused) return;
    setCurrentMs(video.currentTime * 1000);
  }

  const cropCenterX = (state.layout.crop.x + state.layout.crop.w / 2) * 100;
  const cropCenterY = (state.layout.crop.y + state.layout.crop.h / 2) * 100;
  const zoom =
    state.layout.mode === "manual" ? 1 / Math.max(state.layout.crop.w, state.layout.crop.h, 0.2) : 1;

  const safeBounds = safeAreaBounds({ width: STAGE_WIDTH, height: STAGE_HEIGHT });
  const maxRowWidth = Math.max(0, ...(layout?.rows.map((row) => row.widthPx) ?? []));
  const maxWordWidth = Math.max(0, ...(layout?.words.map((word) => word.widthPx) ?? []));
  const popReserveX = (maxWordWidth * Math.max(0, style.highlightScale - 1)) / 2;
  const popReserveY =
    ((layout?.rows[0]?.heightPx ?? style.sizePx) * Math.max(0, style.highlightScale - 1)) / 2;
  const selectionBounds = layout
    ? {
        left: layout.blockCenterX - maxRowWidth / 2 - popReserveX,
        top: layout.blockTopY - popReserveY,
        width: maxRowWidth + popReserveX * 2,
        height: layout.blockHeightPx + popReserveY * 2,
      }
    : null;
  const dragDelta =
    dragPlacement && layout
      ? {
          x: (dragPlacement.positionX / 100) * STAGE_WIDTH - layout.blockCenterX,
          y: (dragPlacement.positionY / 100) * STAGE_HEIGHT - layout.blockCenterY,
        }
      : { x: 0, y: 0 };
  const visuallySafe = selectionBounds
    ? selectionBounds.left + dragDelta.x >= safeBounds.left &&
      selectionBounds.left + selectionBounds.width + dragDelta.x <= safeBounds.right &&
      selectionBounds.top + dragDelta.y >= safeBounds.top &&
      selectionBounds.top + selectionBounds.height + dragDelta.y <= safeBounds.bottom
    : true;

  function positionFromPointer(clientX: number, clientY: number): CaptionPlacement {
    const wrap = stageWrapRef.current;
    if (!wrap || !layout || !selectionBounds) {
      return { positionX: style.positionX, positionY: style.positionY };
    }
    const rect = wrap.getBoundingClientRect();
    let x = ((clientX - rect.left) / rect.width) * 100 - dragOffsetRef.current.x;
    let y = ((clientY - rect.top) / rect.height) * 100 - dragOffsetRef.current.y;
    const leftOffsetPct = ((layout.blockCenterX - selectionBounds.left) / STAGE_WIDTH) * 100;
    const rightOffsetPct =
      ((selectionBounds.left + selectionBounds.width - layout.blockCenterX) / STAGE_WIDTH) * 100;
    const topOffsetPct = ((layout.blockCenterY - selectionBounds.top) / STAGE_HEIGHT) * 100;
    const bottomOffsetPct =
      ((selectionBounds.top + selectionBounds.height - layout.blockCenterY) / STAGE_HEIGHT) * 100;
    x = Math.min(98 - rightOffsetPct, Math.max(2 + leftOffsetPct, x));
    y = Math.min(98 - bottomOffsetPct, Math.max(2 + topOffsetPct, y));

    const verticalTargets = [
      ((safeBounds.top + popReserveY + layout.blockHeightPx / 2) / STAGE_HEIGHT) * 100,
      50,
      ((safeBounds.bottom - popReserveY - layout.blockHeightPx / 2) / STAGE_HEIGHT) * 100,
    ];
    if (Math.abs(x - 50) <= SNAP_THRESHOLD) x = 50;
    for (const target of verticalTargets) {
      if (Math.abs(y - target) <= SNAP_THRESHOLD) y = target;
    }
    return {
      positionX: Math.round(x * 2) / 2,
      positionY: Math.round(y * 2) / 2,
    };
  }

  function handleDragPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!layout) return;
    event.preventDefault();
    event.stopPropagation();
    videoRef.current?.pause();
    onCaptionSelectedChange?.(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = stageWrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffsetRef.current = {
      x: ((event.clientX - rect.left) / rect.width) * 100 - (layout.blockCenterX / STAGE_WIDTH) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100 - (layout.blockCenterY / STAGE_HEIGHT) * 100,
    };
    setDragPlacement({
      positionX: (layout.blockCenterX / STAGE_WIDTH) * 100,
      positionY: (layout.blockCenterY / STAGE_HEIGHT) * 100,
    });
  }

  function handleDragPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragPlacement === null) return;
    setDragPlacement(positionFromPointer(event.clientX, event.clientY));
  }

  function handleDragPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragPlacement === null) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onCaptionPositionChange?.(positionFromPointer(event.clientX, event.clientY));
    setDragPlacement(null);
  }

  function handleDragKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!layout || !event.key.startsWith("Arrow")) return;
    const directions: Record<string, { x: number; y: number }> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    onCaptionPositionChange?.({
      positionX: Math.min(96, Math.max(4, (layout.blockCenterX / STAGE_WIDTH) * 100 + direction.x * step)),
      positionY: Math.min(96, Math.max(4, (layout.blockCenterY / STAGE_HEIGHT) * 100 + direction.y * step)),
    });
  }

  return (
    <div
      className={`overflow-hidden rounded-lg border border-white/10 bg-black shadow-2xl ${
        fillHeight ? "h-full aspect-[9/16]" : ""
      }`}
    >
      <div
        ref={stageWrapRef}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onCaptionSelectedChange?.(false);
        }}
        className={`relative aspect-[9/16] overflow-hidden bg-black ${
          fillHeight ? "h-full w-full" : "w-full"
        }`}
      >
        <video
          ref={videoRef}
          src={sourceVideoUrl}
          onTimeUpdate={handleTimeUpdate}
          controls
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
          style={{
            objectPosition: `${cropCenterX}% ${cropCenterY}%`,
            transform: zoom !== 1 ? `scale(${zoom})` : undefined,
          }}
        />

        {showSafeZones || captionSelected || dragPlacement ? (
          <div
            className="pointer-events-none absolute border border-dashed border-red-400/80"
            style={{
              left: `${UNIVERSAL_SOCIAL_SAFE_AREA.insetLeftPct}%`,
              right: `${UNIVERSAL_SOCIAL_SAFE_AREA.insetRightPct}%`,
              top: `${UNIVERSAL_SOCIAL_SAFE_AREA.insetTopPct}%`,
              bottom: `${UNIVERSAL_SOCIAL_SAFE_AREA.insetBottomPct}%`,
            }}
          />
        ) : null}

        {/* Caption stage: virtual 1080x1920, the ASS coordinate space, scaled to fit. */}
        <div
          className="pointer-events-none absolute left-0 top-0"
          style={{
            width: STAGE_WIDTH,
            height: STAGE_HEIGHT,
            transform: `scale(${stageScale})`,
            transformOrigin: "top left",
            opacity: fontsReady ? 1 : 0,
          }}
        >
          {layout ? (
            <div
              style={{
                transform:
                  dragDelta.x || dragDelta.y
                    ? `translate(${dragDelta.x}px, ${dragDelta.y}px)`
                    : undefined,
              }}
            >
              {style.background === "pill"
                ? layout.rows.map((row) => {
                    const padX = Math.round(style.sizePx * 0.4);
                    return (
                      <div
                        key={`row-${row.index}`}
                        className="absolute rounded-sm"
                        style={{
                          left: row.xCenter - (row.widthPx + 2 * padX) / 2,
                          top: row.yTop,
                          width: row.widthPx + 2 * padX,
                          height: row.heightPx,
                          backgroundColor: "rgba(0,0,0,0.5)",
                        }}
                      />
                    );
                  })
                : null}
              {layout.words.map((word) => {
                const active =
                  style.highlightMode === "word" &&
                  currentMs >= word.startMs &&
                  currentMs < word.endMs;
                const scale = active
                  ? wordScaleAt(currentMs - word.startMs, style.highlightScale)
                  : 1;
                return (
                  <span
                    key={word.id}
                    className="absolute whitespace-pre"
                    style={{
                      left: word.xCenter,
                      top: word.yCenter,
                      transform: `translate(-50%, -50%) scale(${scale})`,
                      fontFamily: style.fontFamily,
                      fontSize: style.sizePx,
                      fontWeight: style.fontWeight,
                      lineHeight: 1,
                      color: active ? style.highlightColor : style.textColor,
                      // ASS strokes outward from the glyph edge; -webkit-text-stroke centers
                      // on it, so double the width and paint the stroke under the fill.
                      WebkitTextStroke:
                        style.outlineWidthPx > 0
                          ? `${style.outlineWidthPx * 2}px ${style.outlineColor}`
                          : undefined,
                      paintOrder: "stroke fill",
                      textShadow:
                        style.shadowDistancePx > 0
                          ? `${style.shadowDistancePx}px ${style.shadowDistancePx}px 0 ${style.shadowColor}`
                          : undefined,
                    }}
                  >
                    {word.text}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>

        {/* The caption block itself is the drag target. */}
        {onCaptionPositionChange && selectionBounds ? (
          <div
            role="button"
            aria-label="Move all captions"
            tabIndex={0}
            onPointerDown={handleDragPointerDown}
            onPointerMove={handleDragPointerMove}
            onPointerUp={handleDragPointerUp}
            onKeyDown={handleDragKeyDown}
            className={`group absolute z-10 cursor-move touch-none rounded-md border-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
              captionSelected || dragPlacement
                ? visuallySafe
                  ? "border-white/90 bg-white/5"
                  : "border-amber-400 bg-amber-400/10"
                : "border-transparent"
            }`}
            style={{
              left: `${((selectionBounds.left + dragDelta.x) / STAGE_WIDTH) * 100}%`,
              top: `${((selectionBounds.top + dragDelta.y) / STAGE_HEIGHT) * 100}%`,
              width: `${(selectionBounds.width / STAGE_WIDTH) * 100}%`,
              height: `${(selectionBounds.height / STAGE_HEIGHT) * 100}%`,
            }}
          >
            {captionSelected || dragPlacement ? (
              <span className={`absolute -top-6 left-0 whitespace-nowrap rounded px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${visuallySafe ? "bg-white text-black" : "bg-amber-400 text-black"}`}>
                {visuallySafe ? "All captions · drag" : "Outside social-safe area"}
              </span>
            ) : null}
          </div>
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
  );
}
