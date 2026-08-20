"use client";

import { applyTextCase } from "@/lib/editor/text-case";
import { useEffect, useRef, useState } from "react";
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
  const seekedRef = useRef(false);

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
    setCurrentMs(seek.ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek?.token]);

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    const ms = video.currentTime * 1000;

    if (ms >= state.source.endMs) {
      video.currentTime = state.source.startMs / 1000;
      setCurrentMs(state.source.startMs);
      return;
    }

    const deletedWord = words.find(
      (word) => word.effectiveDeleted && ms >= word.startMs && ms < word.endMs,
    );
    if (deletedWord) {
      video.currentTime = deletedWord.endMs / 1000;
      return;
    }

    setCurrentMs(ms);
  }

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
          controls
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
          style={{
            objectPosition: `${cropCenterX}% ${cropCenterY}%`,
            transform: zoom !== 1 ? `scale(${zoom})` : undefined,
          }}
        />

        {showSafeZones ? (
          <div className="pointer-events-none absolute inset-x-[6%] top-[6%] bottom-[12%] border border-dashed border-white/60" />
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
    </div>
  );
}
