"use client";

import {
  Film,
  Pause,
  Play,
  Plus,
  SkipBack,
  SkipForward,
  Type,
  Volume2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clampEnd,
  clampRegion,
  clampStart,
  computeTimelineViewport,
  snapToBoundary,
  type TrimViewport,
} from "@/lib/editor/trim";
import { createTitleBanner, type TitleBannerOverlay } from "@/lib/editor/title-banner";
import type { WordNavigationRequest } from "@/lib/editor/transcript-workspace";
import type { EditorWord } from "@/lib/editor/words";

const SNAP_FRACTION = 0.02;
const NUDGE_MS = 200;
const NUDGE_LARGE_MS = 1_000;
const WAVEFORM_BARS = 120;

type DragKind =
  | "start"
  | "end"
  | "region"
  | "title-start"
  | "title-end"
  | "title-region";

const TITLE_MIN_DURATION_MS = 250;

function formatRulerClock(ms: number): string {
  const totalS = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalS / 60)}:${String(totalS % 60).padStart(2, "0")}`;
}

function formatTransportClock(ms: number): string {
  const centiseconds = Math.max(0, Math.round(ms / 10));
  const minutes = Math.floor(centiseconds / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function readKind(target: EventTarget | null): DragKind | null {
  const el = (target as HTMLElement | null)?.closest?.("[data-trim]");
  const kind = el?.getAttribute("data-trim");
  return kind === "start" ||
    kind === "end" ||
    kind === "region" ||
    kind === "title-start" ||
    kind === "title-end" ||
    kind === "title-region"
    ? kind
    : null;
}

function waveformPeaks(
  words: readonly EditorWord[],
  view: TrimViewport,
): number[] {
  const span = Math.max(1, view.end - view.start);
  const binMs = span / WAVEFORM_BARS;
  return Array.from({ length: WAVEFORM_BARS }, (_, index) => {
    const start = view.start + index * binMs;
    const end = start + binMs;
    const spoken = words.filter((word) => word.startMs < end && word.endMs > start);
    if (spoken.length === 0) return 0.08;
    const energy = spoken.reduce((sum, word) => sum + Math.min(12, word.word.length), 0);
    return Math.min(1, 0.2 + energy / 18 + ((index * 17) % 5) / 20);
  });
}

export function ClipTimeline({
  sourceDurationMs,
  sourceVideoUrl,
  defaultTitle,
  titleBanner,
  startMs,
  endMs,
  currentMs,
  playing,
  audioVolume,
  wordBoundaries,
  words,
  focusRequest = null,
  onTrim,
  onScrub,
  onTransport,
  onTitleBannerChange,
  onTitleTrackSelect,
  onAudioTrackSelect,
  onVideoTrackSelect,
  onInteractionStart,
  onInteractionEnd,
}: {
  simpleMode?: boolean;
  sourceDurationMs: number;
  sourceVideoUrl: string;
  defaultTitle: string;
  titleBanner: TitleBannerOverlay | null;
  startMs: number;
  endMs: number;
  currentMs: number;
  playing: boolean;
  audioVolume: number;
  wordBoundaries: number[];
  words: EditorWord[];
  focusRequest?: WordNavigationRequest | null;
  onTrim: (startMs: number, endMs: number) => void;
  onScrub: (ms: number) => void;
  onTransport: (command: "start" | "toggle" | "end") => void;
  onTitleBannerChange: (banner: TitleBannerOverlay | null) => void;
  onTitleTrackSelect: () => void;
  onAudioTrackSelect: () => void;
  onVideoTrackSelect: () => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ kind: DragKind; grabOffsetMs: number } | null>(null);
  const [zoom, setZoom] = useState(0);
  const [filmstripFrames, setFilmstripFrames] = useState<string[]>([]);
  const [viewportCenterMs, setViewportCenterMs] = useState(currentMs);
  const [dismissedFocusToken, setDismissedFocusToken] = useState<number | null>(null);
  const [frozenView, setFrozenView] = useState<TrimViewport | null>(null);
  const requestedCenterMs =
    focusRequest && focusRequest.token !== dismissedFocusToken
      ? focusRequest.ms
      : viewportCenterMs;
  const view =
    frozenView ??
    computeTimelineViewport(startMs, endMs, sourceDurationMs, requestedCenterMs, zoom);

  useEffect(() => {
    let canceled = false;
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = sourceVideoUrl;

    const waitForVideoEvent = (event: "loadedmetadata" | "seeked") =>
      new Promise<void>((resolve) => {
        video.addEventListener(event, () => resolve(), { once: true });
        video.addEventListener("error", () => resolve(), { once: true });
      });

    void (async () => {
      if (video.readyState < 1) await waitForVideoEvent("loadedmetadata");
      if (canceled || !Number.isFinite(video.duration) || video.duration <= 0) return;

      const frameCount = 14;
      const canvas = document.createElement("canvas");
      canvas.width = 180;
      canvas.height = 102;
      const context = canvas.getContext("2d");
      if (!context) return;

      const frames: string[] = [];
      for (let index = 0; index < frameCount; index += 1) {
        const ratio = (index + 0.5) / frameCount;
        const requestedMs = view.start + (view.end - view.start) * ratio;
        const seconds = Math.min(video.duration - 0.05, Math.max(0, requestedMs / 1000));
        if (Math.abs(video.currentTime - seconds) > 0.01) {
          video.currentTime = seconds;
          await waitForVideoEvent("seeked");
        }
        if (canceled) return;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(canvas.toDataURL("image/jpeg", 0.68));
      }
      if (!canceled) setFilmstripFrames(frames);
    })();

    return () => {
      canceled = true;
      video.removeAttribute("src");
      video.load();
    };
  }, [sourceVideoUrl, view.end, view.start]);

  const span = Math.max(1, view.end - view.start);
  const msToPct = useCallback(
    (ms: number) => Math.min(100, Math.max(0, ((ms - view.start) / span) * 100)),
    [span, view.start],
  );

  const clientXToMs = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return view.start;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return view.start + ratio * span;
    },
    [span, view.start],
  );

  const snap = useCallback(
    (ms: number) => snapToBoundary(ms, wordBoundaries, span * SNAP_FRACTION),
    [span, wordBoundaries],
  );

  const handlePointerDown = (event: React.PointerEvent) => {
    const timelineTrack = (event.target as HTMLElement | null)
      ?.closest?.("[data-timeline-track]")
      ?.getAttribute("data-timeline-track");
    if (timelineTrack === "video") onVideoTrackSelect();
    const kind = readKind(event.target);
    if (!kind) {
      onScrub(Math.round(clientXToMs(event.clientX)));
      return;
    }
    event.preventDefault();
    const ms = clientXToMs(event.clientX);
    if (kind.startsWith("title-")) openTitleTrack();
    dragRef.current = {
      kind,
      grabOffsetMs:
        kind === "region"
          ? ms - startMs
          : kind === "title-region" && titleBanner
            ? ms - titleBanner.startMs
            : 0,
    };
    onInteractionStart?.();
    setFrozenView(view);
    trackRef.current?.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const ms = clientXToMs(event.clientX);
    if (drag.kind === "start") {
      const next = clampStart(snap(ms), endMs);
      onTrim(next, endMs);
      onScrub(next);
    } else if (drag.kind === "end") {
      const next = clampEnd(snap(ms), startMs, sourceDurationMs);
      onTrim(startMs, next);
      onScrub(next);
    } else if (drag.kind === "region") {
      const region = clampRegion(ms - drag.grabOffsetMs, endMs - startMs, sourceDurationMs);
      onTrim(region.startMs, region.endMs);
    } else if (titleBanner && drag.kind === "title-start") {
      const next = Math.min(
        titleBanner.endMs - TITLE_MIN_DURATION_MS,
        Math.max(startMs, snap(ms)),
      );
      onTitleBannerChange({ ...titleBanner, startMs: Math.round(next) });
      onScrub(Math.round(next));
    } else if (titleBanner && drag.kind === "title-end") {
      const next = Math.max(
        titleBanner.startMs + TITLE_MIN_DURATION_MS,
        Math.min(endMs, snap(ms)),
      );
      onTitleBannerChange({ ...titleBanner, endMs: Math.round(next) });
      onScrub(Math.round(next));
    } else if (titleBanner && drag.kind === "title-region") {
      const duration = titleBanner.endMs - titleBanner.startMs;
      const nextStart = Math.min(
        endMs - duration,
        Math.max(startMs, ms - drag.grabOffsetMs),
      );
      onTitleBannerChange({
        ...titleBanner,
        startMs: Math.round(nextStart),
        endMs: Math.round(nextStart + duration),
      });
    }
  };

  const endDrag = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    trackRef.current?.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
    setFrozenView(null);
    onInteractionEnd?.();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const kind = event.currentTarget.getAttribute("data-trim");
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const delta = direction * (event.shiftKey ? NUDGE_LARGE_MS : NUDGE_MS);
    if (kind === "start") {
      const next = clampStart(startMs + delta, endMs);
      onTrim(next, endMs);
      onScrub(next);
    } else if (kind === "end") {
      const next = clampEnd(endMs + delta, startMs, sourceDurationMs);
      onTrim(startMs, next);
      onScrub(next);
    } else if (titleBanner && kind === "title-start") {
      const next = Math.min(
        titleBanner.endMs - TITLE_MIN_DURATION_MS,
        Math.max(startMs, titleBanner.startMs + delta),
      );
      onTitleBannerChange({ ...titleBanner, startMs: next });
      onScrub(next);
    } else if (titleBanner && kind === "title-end") {
      const next = Math.max(
        titleBanner.startMs + TITLE_MIN_DURATION_MS,
        Math.min(endMs, titleBanner.endMs + delta),
      );
      onTitleBannerChange({ ...titleBanner, endMs: next });
      onScrub(next);
    }
  };

  const startPct = msToPct(startMs);
  const endPct = msToPct(endMs);
  const playheadVisible = currentMs >= view.start && currentMs <= view.end;
  const titleStartPct = titleBanner ? msToPct(titleBanner.startMs) : 0;
  const titleEndPct = titleBanner ? msToPct(titleBanner.endMs) : 0;
  const peaks = useMemo(() => waveformPeaks(words, view), [view, words]);

  const rulerTimes = Array.from({ length: 5 }, (_, index) => view.start + (span * index) / 4);

  function openTitleTrack() {
    if (!titleBanner) {
      onTitleBannerChange(
        createTitleBanner({
          text: defaultTitle,
          startMs,
          endMs: Math.min(endMs, startMs + 3_000),
        }),
      );
    } else if (currentMs < titleBanner.startMs || currentMs >= titleBanner.endMs) {
      onScrub(titleBanner.startMs);
    }
    onTitleTrackSelect();
  }

  return (
    <section
      className="clip-timeline h-full overflow-hidden bg-[#151515] px-2 py-2 text-white lg:px-4 lg:py-3"
      data-advanced-tracks="true"
      aria-label="Timeline editor"
    >
      <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-white/10 pb-2">
        <div />
        <div className="flex items-center justify-center gap-1 sm:gap-2">
          <TransportButton label="Back to clip start" onClick={() => onTransport("start")}>
            <SkipBack size={17} aria-hidden="true" />
          </TransportButton>
          <TransportButton label={playing ? "Pause" : "Play"} onClick={() => onTransport("toggle")} primary>
            {playing ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
          </TransportButton>
          <TransportButton label="Forward to clip end" onClick={() => onTransport("end")}>
            <SkipForward size={17} aria-hidden="true" />
          </TransportButton>
          <p className="ml-1 hidden text-xs font-medium tabular-nums text-white sm:block">
            {formatTransportClock(currentMs - startMs)}
            <span className="px-1.5 text-stone-500">/</span>
            <span className="text-stone-400">{formatTransportClock(endMs - startMs)}</span>
          </p>
        </div>
        <div className="flex items-center justify-end gap-1.5 pl-2">
          <ZoomOut size={15} className="hidden text-stone-500 sm:block" aria-hidden="true" />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(zoom * 100)}
            onChange={(event) => {
              setViewportCenterMs(currentMs);
              setDismissedFocusToken(focusRequest?.token ?? null);
              setZoom(Number(event.target.value) / 100);
            }}
            className="h-1.5 w-16 accent-red-600 sm:w-24 lg:w-28"
            aria-label="Timeline zoom"
          />
          <ZoomIn size={15} className="text-stone-400" aria-hidden="true" />
        </div>
      </div>

      <div className="grid grid-cols-[64px_minmax(0,1fr)] pt-1 lg:grid-cols-[104px_minmax(0,1fr)]">
        <div />
        <div className="flex justify-between px-1 text-[9px] tabular-nums text-stone-600">
          {rulerTimes.map((time, index) => (
            <span key={index}>{formatRulerClock(time)}</span>
          ))}
        </div>
      </div>

      <div className="grid min-h-0 grid-cols-[64px_minmax(0,1fr)] lg:grid-cols-[104px_minmax(0,1fr)]">
        <div className="grid grid-rows-[34px_50px_34px] border-y border-l border-white/10 bg-[#111111] lg:grid-rows-[38px_58px_40px]">
          <TrackLabel icon={Type} label="Title" onClick={openTitleTrack} />
          <TrackLabel icon={Film} label="Video" onClick={onVideoTrackSelect} />
          <TrackLabel icon={Volume2} label="Audio" onClick={onAudioTrackSelect} />
        </div>

        <div
          ref={trackRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="relative grid touch-none select-none grid-rows-[34px_50px_34px] overflow-hidden border border-white/10 bg-[#242424] lg:grid-rows-[38px_58px_40px]"
          role="group"
          aria-label="Clip trim timeline"
        >
          <TimelineRow startPct={startPct} endPct={endPct} className="bg-[#1b1b1b]">
            {titleBanner ? (
              <div
                data-trim="title-region"
                role="slider"
                tabIndex={0}
                aria-label="Title timing"
                aria-valuemin={Math.round(startMs)}
                aria-valuemax={Math.round(endMs)}
                aria-valuenow={Math.round(titleBanner.startMs)}
                onKeyDown={handleKeyDown}
                className="absolute inset-y-1 z-30 flex min-w-10 cursor-grab items-center gap-1 rounded bg-red-700/90 px-2 shadow-sm active:cursor-grabbing"
                style={{
                  left: `${titleStartPct}%`,
                  width: `${Math.max(0, titleEndPct - titleStartPct)}%`,
                }}
              >
                <TitleTrimHandle kind="title-start" onKeyDown={handleKeyDown} />
                <div className="pointer-events-none flex min-w-0 flex-1 items-center gap-1 text-left">
                  <Type size={12} className="shrink-0" aria-hidden="true" />
                  <span className="truncate text-[10px] font-semibold text-white">
                    {titleBanner.text || "Title banner"}
                  </span>
                </div>
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onTitleBannerChange(null)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-red-100 hover:bg-black/20"
                  aria-label="Remove title banner"
                >
                  <X size={12} aria-hidden="true" />
                </button>
                <TitleTrimHandle kind="title-end" onKeyDown={handleKeyDown} />
              </div>
            ) : (
              <button
                type="button"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={openTitleTrack}
                style={{ left: `calc(${startPct}% + 0.5rem)` }}
                className="absolute top-1/2 z-30 flex h-7 -translate-y-1/2 items-center gap-1 rounded border border-dashed border-white/20 px-2 text-[10px] font-semibold text-stone-300 hover:border-red-500/70 hover:text-white"
              >
                <Plus size={12} aria-hidden="true" /> Add title
              </button>
            )}
          </TimelineRow>

          <TimelineRow
            startPct={startPct}
            endPct={endPct}
            className="bg-[#202020]"
            track="video"
          >
            <div
              data-trim="region"
              className="absolute inset-y-0 cursor-grab border-y border-white/70 active:cursor-grabbing"
              style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
              aria-hidden="true"
            />
            <div className="pointer-events-none absolute inset-0 flex opacity-80">
              {filmstripFrames.length > 0
                ? filmstripFrames.map((frame, index) => (
                    <span
                      key={`${index}-${frame.slice(-12)}`}
                      className="min-w-0 flex-1 border-r border-black/60 bg-cover bg-center last:border-r-0"
                      style={{ backgroundImage: `url(${frame})` }}
                    />
                  ))
                : Array.from({ length: 14 }, (_, index) => (
                    <span
                      key={index}
                      className="min-w-0 flex-1 border-r border-black/60 bg-cover bg-center last:border-r-0"
                      style={{ background: index % 2 === 0 ? "#2a2a2a" : "#353535" }}
                    />
                  ))}
            </div>
          </TimelineRow>

          <TimelineRow startPct={startPct} endPct={endPct} className="bg-[#202020]">
            <div className="pointer-events-none absolute inset-0 flex items-center gap-px px-1">
              {peaks.map((peak, index) => (
                <span
                  key={index}
                  className="min-w-px flex-1 rounded-full bg-stone-400/65"
                  style={{ height: `${Math.max(8, peak * 88)}%` }}
                />
              ))}
            </div>
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onAudioTrackSelect}
              className="absolute inset-0 z-10 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500"
              aria-label="Open audio volume controls"
            >
              <span className="absolute right-2 top-1/2 -translate-y-1/2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-stone-300">
                {Math.round(audioVolume * 100)}%
              </span>
            </button>
          </TimelineRow>

          {playheadVisible ? (
            <div
              className="pointer-events-none absolute inset-y-0 z-30 w-px bg-red-500 shadow-[0_0_0_1px_rgba(0,0,0,0.3)]"
              style={{ left: `${msToPct(currentMs)}%` }}
              aria-hidden="true"
            >
              <span className="absolute -left-1.5 -top-0.5 h-2.5 w-3 rounded-b-sm bg-red-500" />
            </div>
          ) : null}

          <TrimHandle
            kind="start"
            pct={startPct}
            valueNow={startMs}
            valueMax={sourceDurationMs}
            valueLabel={formatRulerClock(startMs)}
            onKeyDown={handleKeyDown}
          />
          <TrimHandle
            kind="end"
            pct={endPct}
            valueNow={endMs}
            valueMax={sourceDurationMs}
            valueLabel={formatRulerClock(endMs)}
            onKeyDown={handleKeyDown}
          />
        </div>
      </div>
    </section>
  );
}

function TrackLabel({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  label: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <Icon size={13} className="shrink-0" aria-hidden={true} />
      <span className="truncate">{label}</span>
    </>
  );

  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 border-b border-white/10 px-2 text-left text-[10px] font-semibold text-stone-400 hover:bg-white/5 hover:text-white last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500 lg:px-3"
    >
      {content}
    </button>
  ) : (
    <div className="flex items-center gap-2 border-b border-white/10 px-2 text-[10px] font-semibold text-stone-400 last:border-b-0 lg:px-3">
      {content}
    </div>
  );
}

function TimelineRow({
  startPct,
  endPct,
  className,
  track,
  children,
}: {
  startPct: number;
  endPct: number;
  className: string;
  track?: "video";
  children: React.ReactNode;
}) {
  return (
    <div
      data-timeline-track={track}
      className={`relative overflow-hidden border-b border-white/10 last:border-b-0 ${className}`}
    >
      {children}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 z-20 bg-stone-500/65 backdrop-grayscale"
        style={{ width: `${startPct}%` }}
      />
      <div
        className="pointer-events-none absolute inset-y-0 right-0 z-20 bg-stone-500/65 backdrop-grayscale"
        style={{ left: `${endPct}%` }}
      />
    </div>
  );
}

function TransportButton({
  label,
  onClick,
  primary = false,
  children,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 ${
        primary ? "text-white hover:bg-white/10" : "text-stone-300 hover:bg-white/10 hover:text-white"
      }`}
      aria-label={label}
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
}: {
  kind: "start" | "end";
  pct: number;
  valueNow: number;
  valueMax: number;
  valueLabel: string;
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  return (
    <div
      data-trim={kind}
      onKeyDown={onKeyDown}
      role="slider"
      tabIndex={0}
      aria-label={kind === "start" ? "Clip start" : "Clip end"}
      aria-valuemin={0}
      aria-valuemax={Math.round(valueMax)}
      aria-valuenow={Math.round(valueNow)}
      aria-valuetext={valueLabel}
      className="absolute inset-y-0 z-40 flex w-11 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 lg:w-4"
      style={{ left: `${pct}%` }}
    >
      <div className="pointer-events-none h-full w-1 rounded bg-red-600 shadow" />
    </div>
  );
}

function TitleTrimHandle({
  kind,
  onKeyDown,
}: {
  kind: "title-start" | "title-end";
  onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  return (
    <button
      type="button"
      data-trim={kind}
      onKeyDown={onKeyDown}
      aria-label={kind === "title-start" ? "Title start" : "Title end"}
      className={`absolute inset-y-0 z-10 flex w-5 cursor-ew-resize touch-none items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white ${
        kind === "title-start" ? "left-0" : "right-0"
      }`}
    >
      <span className="h-5 w-1 rounded-full bg-white shadow" aria-hidden="true" />
    </button>
  );
}
