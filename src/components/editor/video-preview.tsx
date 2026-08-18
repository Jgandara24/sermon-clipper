"use client";

import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyCaptionTextOverrides, buildCaptionLines } from "@/lib/editor/caption-lines";
import {
  activeCaptionWordId,
  overshootScale,
  wordScaleAt,
} from "@/lib/editor/caption-animation";
import { layoutCaptionLine } from "@/lib/editor/caption-layout";
import {
  resizeCaptionFromCorner,
  type CaptionResizeCorner,
} from "@/lib/editor/caption-transform";
import { CAPTION_STYLE_LIMITS } from "@/lib/editor/caption-presets";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import { resolveCaptionFont } from "@/lib/editor/fonts";
import { safeAreaBounds, UNIVERSAL_SOCIAL_SAFE_AREA } from "@/lib/editor/social-safe-area";
import type { EditorState } from "@/lib/editor/types";
import type { TitleBannerOverlay } from "@/lib/editor/title-banner";
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
  onCaptionSizeChange,
  titleBanner = null,
  titleSelected = false,
  onTitleSelectedChange,
  onTitleBannerChange,
  playbackRequest = null,
  onPlaybackChange,
  simpleMode = false,
  playing = false,
  onTransport,
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
  /** Corner-handle resize writes the caption font size into the editor state. */
  onCaptionSizeChange?: (sizePx: number) => void;
  titleBanner?: TitleBannerOverlay | null;
  titleSelected?: boolean;
  onTitleSelectedChange?: (selected: boolean) => void;
  onTitleBannerChange?: (banner: TitleBannerOverlay) => void;
  playbackRequest?: { command: "toggle"; token: number } | null;
  onPlaybackChange?: (playing: boolean) => void;
  simpleMode?: boolean;
  playing?: boolean;
  onTransport?: (command: "toggle") => void;
  /** External seek request (from clicking/dragging the timeline). Bump `token` to re-seek. */
  seek?: { ms: number; token: number } | null;
  fillHeight?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const [currentMs, setCurrentMsState] = useState(state.source.startMs);
  const [stageScale, setStageScale] = useState(0.2);
  const [dragPlacement, setDragPlacement] = useState<CaptionPlacement | null>(null);
  const [resizeSizePx, setResizeSizePx] = useState<number | null>(null);
  const [titleTransformDraft, setTitleTransformDraft] = useState<TitleBannerOverlay | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const titleDragOffsetRef = useRef({ x: 0, y: 0 });
  const titleResizeRef = useRef<{
    corner: CaptionResizeCorner;
    startClientX: number;
    startWidthPct: number;
    startFontSizePx: number;
  } | null>(null);
  const resizeRef = useRef<{
    corner: CaptionResizeCorner;
    centerX: number;
    centerY: number;
    boundsWidth: number;
    boundsHeight: number;
    startSizePx: number;
  } | null>(null);
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

  const resolvedStyle = useMemo(
    () => resolveCaptionStyle(state.captions.presetId, state.captions.overrides),
    [state.captions.presetId, state.captions.overrides],
  );
  const style = useMemo(
    () => (resizeSizePx === null ? resolvedStyle : { ...resolvedStyle, sizePx: resizeSizePx }),
    [resizeSizePx, resolvedStyle],
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

  const activeWordId = activeCaptionWordId(
    captionLines.flatMap((line) => line.words),
    currentMs,
  );
  const currentLine =
    captionLines.find((line) => line.words.some((word) => word.id === activeWordId)) ??
    captionLines.find((line) => currentMs >= line.startMs && currentMs < line.endMs);

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

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackRequest) return;
    if (video.paused) {
      void video.play().catch(() => onPlaybackChange?.(false));
    } else {
      video.pause();
    }
    // A token makes repeated presses of the same command observable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackRequest?.token]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.min(1, Math.max(0, state.audio.originalVolume));
  }, [state.audio.originalVolume]);

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
  const maximumPopScale = overshootScale(style.highlightScale);
  const popReserveX = (maxWordWidth * Math.max(0, maximumPopScale - 1)) / 2;
  const popReserveY =
    ((layout?.rows[0]?.heightPx ?? style.sizePx) * Math.max(0, maximumPopScale - 1)) / 2;
  const transformPaddingX = style.sizePx * 0.5;
  const transformPaddingY = style.sizePx * 0.7;
  const selectionBounds = layout
    ? {
        left: layout.blockCenterX - maxRowWidth / 2 - popReserveX - transformPaddingX,
        top: layout.blockTopY - popReserveY - transformPaddingY,
        width: maxRowWidth + popReserveX * 2 + transformPaddingX * 2,
        height: layout.blockHeightPx + popReserveY * 2 + transformPaddingY * 2,
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

  function pointerInStage(clientX: number, clientY: number) {
    const rect = stageWrapRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * STAGE_WIDTH,
      y: ((clientY - rect.top) / rect.height) * STAGE_HEIGHT,
    };
  }

  function sizeFromPointer(clientX: number, clientY: number): number | null {
    const session = resizeRef.current;
    const pointer = pointerInStage(clientX, clientY);
    if (!session || !pointer) return null;
    return resizeCaptionFromCorner({
      corner: session.corner,
      pointerX: pointer.x,
      pointerY: pointer.y,
      centerX: session.centerX,
      centerY: session.centerY,
      boundsWidth: session.boundsWidth,
      boundsHeight: session.boundsHeight,
      startSizePx: session.startSizePx,
      minSizePx: CAPTION_STYLE_LIMITS.sizePx.min,
      maxSizePx: CAPTION_STYLE_LIMITS.sizePx.max,
    });
  }

  function handleResizePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (!layout || !selectionBounds) return;
    const corner = event.currentTarget.dataset.corner as CaptionResizeCorner;
    event.preventDefault();
    event.stopPropagation();
    videoRef.current?.pause();
    onCaptionSelectedChange?.(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = {
      corner,
      centerX: layout.blockCenterX,
      centerY: layout.blockCenterY,
      boundsWidth: selectionBounds.width,
      boundsHeight: selectionBounds.height,
      startSizePx: resolvedStyle.sizePx,
    };
    setResizeSizePx(resolvedStyle.sizePx);
  }

  function handleResizePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    if (!resizeRef.current) return;
    const sizePx = sizeFromPointer(event.clientX, event.clientY);
    if (sizePx !== null) setResizeSizePx(sizePx);
  }

  function handleResizePointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    if (!resizeRef.current) return;
    const sizePx = sizeFromPointer(event.clientX, event.clientY);
    event.currentTarget.releasePointerCapture(event.pointerId);
    resizeRef.current = null;
    setResizeSizePx(null);
    if (sizePx !== null) onCaptionSizeChange?.(sizePx);
  }

  function handleResizeKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const direction =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -1
          : 0;
    if (direction === 0) return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    onCaptionSizeChange?.(
      Math.min(
        CAPTION_STYLE_LIMITS.sizePx.max,
        Math.max(CAPTION_STYLE_LIMITS.sizePx.min, resolvedStyle.sizePx + direction * step),
      ),
    );
  }

  const displayedTitleBanner = titleTransformDraft ?? titleBanner;

  function titlePositionFromPointer(clientX: number, clientY: number) {
    const rect = stageWrapRef.current?.getBoundingClientRect();
    if (!rect || !displayedTitleBanner) return null;
    const halfWidth = displayedTitleBanner.widthPct / 2;
    const positionX =
      ((clientX - rect.left) / rect.width) * 100 - titleDragOffsetRef.current.x;
    const positionY =
      ((clientY - rect.top) / rect.height) * 100 - titleDragOffsetRef.current.y;
    return {
      positionX: Math.round(Math.min(100 - halfWidth, Math.max(halfWidth, positionX)) * 2) / 2,
      positionY: Math.round(Math.min(96, Math.max(4, positionY)) * 2) / 2,
    };
  }

  function handleTitleDragPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!titleBanner || (event.target as HTMLElement).closest("[data-title-resize]")) return;
    event.preventDefault();
    event.stopPropagation();
    videoRef.current?.pause();
    onCaptionSelectedChange?.(false);
    onTitleSelectedChange?.(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = stageWrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    titleDragOffsetRef.current = {
      x: ((event.clientX - rect.left) / rect.width) * 100 - titleBanner.positionX,
      y: ((event.clientY - rect.top) / rect.height) * 100 - titleBanner.positionY,
    };
    setTitleTransformDraft(titleBanner);
  }

  function handleTitleDragPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!titleTransformDraft || titleResizeRef.current) return;
    const position = titlePositionFromPointer(event.clientX, event.clientY);
    if (position) setTitleTransformDraft((banner) => (banner ? { ...banner, ...position } : banner));
  }

  function handleTitleDragPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!titleTransformDraft || titleResizeRef.current) return;
    const position = titlePositionFromPointer(event.clientX, event.clientY);
    const next = position ? { ...titleTransformDraft, ...position } : titleTransformDraft;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setTitleTransformDraft(null);
    onTitleBannerChange?.(next);
  }

  function handleTitleDragKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!titleBanner || !event.key.startsWith("Arrow")) return;
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
    const halfWidth = titleBanner.widthPct / 2;
    onTitleBannerChange?.({
      ...titleBanner,
      positionX: Math.min(
        100 - halfWidth,
        Math.max(halfWidth, titleBanner.positionX + direction.x * step),
      ),
      positionY: Math.min(96, Math.max(4, titleBanner.positionY + direction.y * step)),
    });
  }

  function titleResizeFromPointer(clientX: number) {
    const session = titleResizeRef.current;
    const rect = stageWrapRef.current?.getBoundingClientRect();
    if (!session || !rect || !titleTransformDraft) return null;
    const horizontalDirection = session.corner.includes("left") ? -1 : 1;
    const deltaPct = ((clientX - session.startClientX) / rect.width) * 200 * horizontalDirection;
    const widthPct = Math.min(100, Math.max(30, session.startWidthPct + deltaPct));
    const fontSizePx = Math.min(
      120,
      Math.max(16, Math.round(session.startFontSizePx * (widthPct / session.startWidthPct))),
    );
    const roundedWidthPct = Math.round(widthPct * 2) / 2;
    const halfWidthPct = roundedWidthPct / 2;
    return {
      widthPct: roundedWidthPct,
      fontSizePx,
      positionX: Math.min(
        100 - halfWidthPct,
        Math.max(halfWidthPct, titleTransformDraft.positionX),
      ),
    };
  }

  function handleTitleResizePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (!titleBanner) return;
    event.preventDefault();
    event.stopPropagation();
    videoRef.current?.pause();
    onCaptionSelectedChange?.(false);
    onTitleSelectedChange?.(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    titleResizeRef.current = {
      corner: event.currentTarget.dataset.titleResize as CaptionResizeCorner,
      startClientX: event.clientX,
      startWidthPct: titleBanner.widthPct,
      startFontSizePx: titleBanner.fontSizePx,
    };
    setTitleTransformDraft(titleBanner);
  }

  function handleTitleResizePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const resize = titleResizeFromPointer(event.clientX);
    if (resize) setTitleTransformDraft((banner) => (banner ? { ...banner, ...resize } : banner));
  }

  function handleTitleResizePointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    if (!titleResizeRef.current || !titleTransformDraft) return;
    const resize = titleResizeFromPointer(event.clientX);
    const next = resize ? { ...titleTransformDraft, ...resize } : titleTransformDraft;
    event.currentTarget.releasePointerCapture(event.pointerId);
    titleResizeRef.current = null;
    setTitleTransformDraft(null);
    onTitleBannerChange?.(next);
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
          if (event.target === event.currentTarget) {
            onCaptionSelectedChange?.(false);
            onTitleSelectedChange?.(false);
          }
        }}
        className={`relative aspect-[9/16] overflow-hidden bg-black ${
          fillHeight ? "h-full w-full" : "w-full"
        }`}
      >
        <video
          ref={videoRef}
          src={sourceVideoUrl}
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => onPlaybackChange?.(true)}
          onPause={() => onPlaybackChange?.(false)}
          onEnded={() => onPlaybackChange?.(false)}
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
          style={{
            objectPosition: `${cropCenterX}% ${cropCenterY}%`,
            transform: zoom !== 1 ? `scale(${zoom})` : undefined,
          }}
        />

        {simpleMode && onTransport ? (
          <div className="pointer-events-none absolute inset-0 z-[6] flex items-center justify-center">
            <button
              type="button"
              onClick={() => onTransport("toggle")}
              className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full border border-white/25 bg-black/70 text-white shadow-2xl backdrop-blur-sm transition hover:scale-105 hover:bg-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              aria-label={playing ? "Pause clip preview" : "Preview clip"}
            >
              {playing ? (
                <Pause size={26} fill="currentColor" aria-hidden="true" />
              ) : (
                <Play size={26} fill="currentColor" aria-hidden="true" />
              )}
            </button>
          </div>
        ) : null}

        {displayedTitleBanner &&
        displayedTitleBanner.text &&
        currentMs >= displayedTitleBanner.startMs &&
        currentMs < displayedTitleBanner.endMs ? (
          <div
            role="group"
            aria-label="Title overlay transform controls"
            tabIndex={0}
            onPointerDown={handleTitleDragPointerDown}
            onPointerMove={handleTitleDragPointerMove}
            onPointerUp={handleTitleDragPointerUp}
            onPointerCancel={handleTitleDragPointerUp}
            onKeyDown={handleTitleDragKeyDown}
            className={`absolute z-20 -translate-x-1/2 -translate-y-1/2 cursor-move touch-none border focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
              titleSelected || titleTransformDraft ? "border-white" : "border-transparent"
            }`}
            style={{
              left: `${displayedTitleBanner.positionX}%`,
              top: `${displayedTitleBanner.positionY}%`,
              width: `${displayedTitleBanner.widthPct}%`,
            }}
          >
            <div
              className="pointer-events-none w-full"
              style={{
                backgroundColor: displayedTitleBanner.backgroundColor,
                color: displayedTitleBanner.textColor,
                borderRadius: displayedTitleBanner.borderRadiusPx * stageScale,
                border:
                  displayedTitleBanner.borderWidthPx > 0
                    ? `${Math.max(1, displayedTitleBanner.borderWidthPx * stageScale)}px solid ${displayedTitleBanner.borderColor}`
                    : undefined,
                padding: `${Math.max(4, 12 * stageScale)}px ${Math.max(8, 24 * stageScale)}px`,
                boxShadow:
                  displayedTitleBanner.shadowDistancePx > 0
                    ? `${displayedTitleBanner.shadowDistancePx * stageScale}px ${displayedTitleBanner.shadowDistancePx * stageScale}px ${displayedTitleBanner.shadowDistancePx * stageScale}px ${displayedTitleBanner.shadowColor}`
                    : undefined,
                fontFamily: resolveCaptionFont(displayedTitleBanner.fontFamily).cssFamily,
                fontSize: Math.max(10, displayedTitleBanner.fontSizePx * stageScale),
                fontWeight: displayedTitleBanner.fontWeight,
                fontStyle: displayedTitleBanner.italic ? "italic" : "normal",
                textDecoration: displayedTitleBanner.underline ? "underline" : "none",
                textAlign: displayedTitleBanner.alignment,
                lineHeight: 1.15,
              }}
            >
              {displayedTitleBanner.text}
            </div>
            {titleSelected || titleTransformDraft
              ? ([
                  ["top-left", "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize"],
                  ["top-right", "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize"],
                  ["bottom-left", "bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize"],
                  ["bottom-right", "bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize"],
                ] as const).map(([corner, positionClass]) => (
                  <button
                    key={corner}
                    type="button"
                    data-title-resize={corner}
                    aria-label={`Resize title from ${corner.replace("-", " ")}`}
                    onPointerDown={handleTitleResizePointerDown}
                    onPointerMove={handleTitleResizePointerMove}
                    onPointerUp={handleTitleResizePointerUp}
                    onPointerCancel={handleTitleResizePointerUp}
                    className={`absolute h-3.5 w-3.5 touch-none rounded-full border-2 border-white bg-black shadow-[0_0_0_1px_rgba(0,0,0,0.5)] ${positionClass}`}
                  />
                ))
              : null}
          </div>
        ) : null}

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
                const active = style.highlightMode === "word" && word.id === activeWordId;
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
        {(onCaptionPositionChange || onCaptionSizeChange) && selectionBounds ? (
          <div
            role="group"
            aria-label="Caption transform controls"
            tabIndex={0}
            onPointerDown={handleDragPointerDown}
            onPointerMove={handleDragPointerMove}
            onPointerUp={handleDragPointerUp}
            onKeyDown={handleDragKeyDown}
            className={`group absolute z-10 cursor-move touch-none border focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
              captionSelected || dragPlacement
                ? visuallySafe
                  ? "border-white"
                  : "border-amber-400"
                : "border-transparent"
            }`}
            style={{
              left: `${((selectionBounds.left + dragDelta.x) / STAGE_WIDTH) * 100}%`,
              top: `${((selectionBounds.top + dragDelta.y) / STAGE_HEIGHT) * 100}%`,
              width: `${(selectionBounds.width / STAGE_WIDTH) * 100}%`,
              height: `${(selectionBounds.height / STAGE_HEIGHT) * 100}%`,
            }}
          >
            {captionSelected || dragPlacement || resizeSizePx !== null
              ? ([
                  ["top-left", "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize"],
                  ["top-right", "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize"],
                  ["bottom-left", "bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize"],
                  ["bottom-right", "bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize"],
                ] as const).map(([corner, positionClass]) => (
                  <button
                    key={corner}
                    type="button"
                    data-corner={corner}
                    aria-label={`Resize captions from ${corner.replace("-", " ")}`}
                    onPointerDown={handleResizePointerDown}
                    onPointerMove={handleResizePointerMove}
                    onPointerUp={handleResizePointerUp}
                    onPointerCancel={handleResizePointerUp}
                    onKeyDown={handleResizeKeyDown}
                    className={`absolute h-3.5 w-3.5 touch-none rounded-full border-2 border-white bg-black shadow-[0_0_0_1px_rgba(0,0,0,0.5)] ${positionClass}`}
                  />
                ))
              : null}
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
