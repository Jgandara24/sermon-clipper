"use client";

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
  onCaptionOffsetChange,
}: {
  sourceVideoUrl: string;
  state: EditorState;
  words: EditorWordWithDeletion[];
  showSafeZones: boolean;
  brandTemplate: EditorBrandTemplate | null;
  onCaptionOffsetChange?: (offset: { x: number; y: number }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [currentMs, setCurrentMs] = useState(state.source.startMs);
  const [draggingCaption, setDraggingCaption] = useState(false);
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

  function captionOffsetFromPointer(event: React.PointerEvent): { x: number; y: number } | null {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.min(0.95, Math.max(0.05, (event.clientX - rect.left) / rect.width)),
      y: Math.min(0.95, Math.max(0.05, (event.clientY - rect.top) / rect.height)),
    };
  }

  function handleCaptionPointerDown(event: React.PointerEvent<HTMLSpanElement>) {
    if (!onCaptionOffsetChange) return;
    event.preventDefault();
    setDraggingCaption(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleCaptionPointerMove(event: React.PointerEvent<HTMLSpanElement>) {
    if (!draggingCaption || !onCaptionOffsetChange) return;
    const offset = captionOffsetFromPointer(event);
    if (offset) onCaptionOffsetChange(offset);
  }

  const cropCenterX = (state.layout.crop.x + state.layout.crop.w / 2) * 100;
  const cropCenterY = (state.layout.crop.y + state.layout.crop.h / 2) * 100;
  const zoom =
    state.layout.mode === "manual" ? 1 / Math.max(state.layout.crop.w, state.layout.crop.h, 0.2) : 1;

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-black shadow-sm">
      <div ref={frameRef} className="relative aspect-[9/16] w-full overflow-hidden bg-black">
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
            className={
              style.offset
                ? "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                : "pointer-events-none absolute inset-x-0 flex justify-center px-4"
            }
            style={
              style.offset
                ? { left: `${style.offset.x * 100}%`, top: `${style.offset.y * 100}%` }
                : {
                    top:
                      style.position === "top" ? "8%" : style.position === "middle" ? "45%" : undefined,
                    bottom: style.position === "bottom" ? "12%" : undefined,
                  }
            }
          >
            <span
              onPointerDown={handleCaptionPointerDown}
              onPointerMove={handleCaptionPointerMove}
              onPointerUp={() => setDraggingCaption(false)}
              className={`rounded px-2 py-1 text-center ${
                onCaptionOffsetChange
                  ? "pointer-events-auto cursor-move touch-none ring-1 ring-white/20 hover:ring-white/60"
                  : ""
              }`}
              title={onCaptionOffsetChange ? "Drag to reposition captions" : undefined}
              style={{
                fontFamily: style.fontFamily,
                fontSize: `${style.sizePx * 0.4}px`,
                fontWeight: style.bold ? 700 : undefined,
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
