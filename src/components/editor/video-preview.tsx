"use client";

import { useEffect, useRef, useState } from "react";
import { applyCaptionTextOverrides, buildCaptionLines } from "@/lib/editor/caption-lines";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import type { EditorState } from "@/lib/editor/types";
import type { EditorWordWithDeletion } from "@/lib/editor/words";

export function VideoPreview({
  sourceVideoId,
  state,
  words,
  showSafeZones,
}: {
  sourceVideoId: string;
  state: EditorState;
  words: EditorWordWithDeletion[];
  showSafeZones: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentMs, setCurrentMs] = useState(state.source.startMs);
  const seekedRef = useRef(false);

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
          src={`/api/videos/${sourceVideoId}/source`}
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
                textTransform: style.uppercase ? "uppercase" : "none",
                backgroundColor: style.background === "pill" ? "rgba(0,0,0,0.55)" : "transparent",
                textShadow: style.shadow ? "0 2px 4px rgba(0,0,0,0.8)" : undefined,
                WebkitTextStroke:
                  style.strokePx > 0 ? `${style.strokePx * 0.3}px ${style.strokeColor}` : undefined,
              }}
            >
              {currentLine.text}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
