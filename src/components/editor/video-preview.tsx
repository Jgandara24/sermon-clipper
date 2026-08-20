"use client";

import {
  ChevronFirst,
  ChevronLast,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampToClip,
  msToTimecode,
  playbackActionForTime,
  seekByMs,
  SKIP_STEP_MS,
} from "@/lib/editor/playback";
import { applyTextCase } from "@/lib/editor/text-case";
import { applyCaptionTextOverrides, buildCaptionLines } from "@/lib/editor/caption-lines";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import type { EditorState } from "@/lib/editor/types";
import type { EditorWordWithDeletion } from "@/lib/editor/words";
import type { EditorBrandTemplate } from "@/components/editor/brand-template-panel";

export function VideoPreview({
  sourceVideoUrl,
  state,
  words,
  showSafeZones,
  brandTemplate,
  onCurrentMsChange,
  seek,
}: {
  sourceVideoUrl: string;
  state: EditorState;
  words: EditorWordWithDeletion[];
  showSafeZones: boolean;
  brandTemplate: EditorBrandTemplate | null;
  /** Reports playback position so the trim timeline can draw a synced playhead. */
  onCurrentMsChange?: (ms: number) => void;
  /** External seek request (from clicking/dragging the timeline). Bump `token` to re-seek. */
  seek?: { ms: number; token: number } | null;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentMs, setCurrentMsState] = useState(state.source.startMs);
  const [isPlaying, setIsPlaying] = useState(false);
  const seekedRef = useRef(false);
  /** A position chosen before the video could accept it; applied once metadata arrives. */
  const pendingSeekRef = useRef<number | null>(null);

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
  const currentLine = captionLines.find(
    (line) => currentMs >= line.startMs && currentMs < line.endMs,
  );

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

  // A centred caption occupies the middle of the frame; the play button must not cover it.
  const captionIsCentred = style.position === "middle" && currentLine !== undefined;
  const cropCenterX = (state.layout.crop.x + state.layout.crop.w / 2) * 100;
  const cropCenterY = (state.layout.crop.y + state.layout.crop.h / 2) * 100;
  const zoom =
    state.layout.mode === "manual" ? 1 / Math.max(state.layout.crop.w, state.layout.crop.h, 0.2) : 1;

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-black shadow-sm">
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-black">
        <video
          ref={videoRef}
          src={sourceVideoUrl}
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onClick={togglePlay}
          playsInline
          className="absolute inset-0 h-full w-full cursor-pointer object-cover"
          style={{
            objectPosition: `${cropCenterX}% ${cropCenterY}%`,
            transform: zoom !== 1 ? `scale(${zoom})` : undefined,
          }}
        />

        {showSafeZones ? (
          <div className="pointer-events-none absolute inset-x-[6%] top-[6%] bottom-[12%] border border-dashed border-white/60" />
        ) : null}

        {/*
          The large play affordance only exists while paused, and it steps out of the way of a
          centred caption rather than sitting on top of the words being reviewed.
        */}
        {!isPlaying ? (
          <button
            type="button"
            onClick={togglePlay}
            aria-label="Play"
            className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/55 p-4 text-white transition hover:bg-black/70"
            style={{ top: captionIsCentred ? "28%" : "50%" }}
          >
            <Play size={28} aria-hidden="true" />
          </button>
        ) : null}

        {currentLine ? (
          <div
            className="pointer-events-none absolute inset-x-0 flex justify-center px-4"
            style={{
              top: style.position === "top" ? "8%" : style.position === "middle" ? "45%" : undefined,
              bottom: style.position === "bottom" ? "12%" : undefined,
            }}
          >
            <span
              className="rounded px-2 py-1 text-center"
              style={{
                fontFamily: style.fontFamily,
                fontSize: `${style.sizePx * 0.4}px`,
                color: style.textColor,
                // No text-transform: the preview lays out the same string the burn-in does, so
                // the two cannot disagree — and CSS cannot express Sentence case or Title Case.
                backgroundColor: style.background === "pill" ? "rgba(0,0,0,0.55)" : "transparent",
                textShadow: style.shadow ? "0 2px 4px rgba(0,0,0,0.8)" : undefined,
                WebkitTextStroke:
                  style.strokePx > 0 ? `${style.strokePx * 0.3}px ${style.strokeColor}` : undefined,
              }}
            >
              {applyTextCase(currentLine.text, style.textCase)}
            </span>
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
        <p className="font-mono text-xs tabular-nums text-white/80">
          <span data-testid="playback-position">
            {msToTimecode(currentMs - state.source.startMs)}
          </span>
          {" / "}
          {msToTimecode(state.source.endMs - state.source.startMs)}
        </p>
      </div>
    </div>
  );
}

function TransportButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded-md p-2 text-white/90 hover:bg-white/15"
    >
      {children}
    </button>
  );
}
