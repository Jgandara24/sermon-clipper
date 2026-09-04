"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FRAME_TILE_WIDTH_PX,
  frameSlots,
  pendingFrameKeys,
  tileCountFor,
  type FrameState,
} from "@/lib/editor/frames";
import type { TrimViewport } from "@/lib/editor/trim";

/** Longer than any seek into a sermon should take; past it the frame is given up on. */
const DECODE_TIMEOUT_MS = 5_000;
/** Frames kept once made. Enough for a long browse; small enough not to matter. */
const CACHE_LIMIT = 600;

/** HTMLMediaElement.HAVE_CURRENT_DATA: a frame for the current position is available to draw. */
const HAVE_CURRENT_DATA = 2;

/**
 * Seeks to a time and resolves only once a frame for it is available to draw.
 *
 * `seeked` says the position moved; it does not by itself say a frame for it has been decoded,
 * and drawing on `seeked` alone is how the row once showed a blue strip. The guarantee the spec
 * does give is readyState: at HAVE_CURRENT_DATA the frame for the current position can be drawn.
 * So after the seek lands that is what is waited for — `loadeddata` announces it when it is not
 * already true — and one animation frame more. (requestVideoFrameCallback would be stronger, but
 * it only reports frames the browser presents, and a video kept out of sight presents none.)
 * A source that errors, or a seek that never lands, rejects.
 */
function awaitDecodedFrame(video: HTMLVideoElement, targetMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadeddata", onFrameAvailable);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("The seek did not land in time.")),
      DECODE_TIMEOUT_MS,
    );
    const onError = () => finish(new Error("The source could not be played."));
    const onFrameAvailable = () => requestAnimationFrame(() => finish());
    const onSeeked = () => {
      if (video.readyState >= HAVE_CURRENT_DATA) onFrameAvailable();
      else video.addEventListener("loadeddata", onFrameAvailable, { once: true });
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    if (video.error) {
      onError();
      return;
    }
    video.currentTime = targetMs / 1000;
  });
}

/** The centre square of the current frame, drawn at tile size into a canvas of its own. */
function captureTile(video: HTMLVideoElement): HTMLCanvasElement | null {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) return null;
  const side = Math.min(videoWidth, videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_TILE_WIDTH_PX;
  canvas.height = FRAME_TILE_WIDTH_PX;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(
    video,
    (videoWidth - side) / 2,
    (videoHeight - side) / 2,
    side,
    side,
    0,
    0,
    FRAME_TILE_WIDTH_PX,
    FRAME_TILE_WIDTH_PX,
  );
  return canvas;
}

/**
 * The Video row's frames: a strip of square tiles, each the source at its own centre.
 *
 * Frames are extracted in the browser from a second, hidden video element on the same signed
 * URL, one seek at a time, only while the window is settled — mid-drag the tiles reuse what has
 * been made and the rest wait. A frame is drawn only once a frame for its time has actually been
 * presented; a seek that fails is retried once, and a frame that still cannot be produced is a
 * neutral placeholder rather than a wrong image. A source that will not play at all makes every
 * tile a placeholder and asks for nothing more.
 *
 * This is the hardened extraction the thumbnails decision chose; worker filmstrips stay P4 work.
 */
export function VideoFrames({
  sourceVideoUrl,
  view,
  settled,
}: {
  sourceVideoUrl: string;
  view: TrimViewport;
  /** False while a trim drag is in progress: the window is moving, so nothing is extracted. */
  settled: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  // What has been made, by frame key. Read and written only in effects.
  const framesRef = useRef(new Map<number, HTMLCanvasElement>());
  const statesRef = useRef(new Map<number, FrameState>());
  const [states, setStates] = useState<ReadonlyMap<number, FrameState>>(new Map());
  const [width, setWidth] = useState(0);
  const [sourceFailed, setSourceFailed] = useState(false);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]?.contentRect.width ?? 0;
      if (next > 0) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const tileCount = tileCountFor(width);
  const { start, end } = view;
  const slots = useMemo(() => frameSlots({ start, end }, tileCount), [start, end, tileCount]);
  const slotsKey = slots.join(",");

  // Extraction: one seek at a time, for the frames the window needs, while it is settled.
  useEffect(() => {
    if (!settled || sourceFailed || width === 0) return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    const publish = () => setStates(new Map(statesRef.current));

    const remember = (key: number, frame: HTMLCanvasElement) => {
      framesRef.current.set(key, frame);
      if (framesRef.current.size > CACHE_LIMIT) {
        const oldest = framesRef.current.keys().next().value;
        if (oldest !== undefined) {
          framesRef.current.delete(oldest);
          statesRef.current.delete(oldest);
        }
      }
    };

    (async () => {
      const wanted = slotsKey === "" ? [] : slotsKey.split(",").map(Number);
      for (const key of pendingFrameKeys(wanted, statesRef.current)) {
        if (cancelled) return;
        let frame: HTMLCanvasElement | null = null;
        for (let attempt = 0; attempt < 2 && !frame; attempt += 1) {
          try {
            await awaitDecodedFrame(video, key);
            if (cancelled) return;
            frame = captureTile(video);
          } catch {
            if (video.error) {
              // Not this frame's fault: the source will not play. Every tile is a placeholder.
              setSourceFailed(true);
              return;
            }
          }
        }
        if (cancelled) return;
        if (frame) {
          remember(key, frame);
          statesRef.current.set(key, "ready");
        } else {
          statesRef.current.set(key, "placeholder");
        }
        publish();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slotsKey, settled, sourceFailed, width, sourceVideoUrl]);

  // Every visible tile shows the frame made for its time, or nothing.
  useEffect(() => {
    slots.forEach((key, index) => {
      const tile = tileRefs.current[index];
      if (!tile) return;
      const context = tile.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, tile.width, tile.height);
      const frame = framesRef.current.get(key);
      if (frame) context.drawImage(frame, 0, 0);
    });
  }, [slots, states]);

  return (
    <div ref={containerRef} className="absolute inset-0 flex overflow-hidden rounded-md" aria-hidden="true">
      {/*
        The extractor. In the layout — a hidden element cannot say when it has presented a frame —
        but sized away to nothing. Metadata only: a seek fetches what it needs, and a sermon is not
        downloaded whole to draw a dozen tiles.
      */}
      <video
        ref={videoRef}
        src={sourceVideoUrl}
        muted
        playsInline
        preload="metadata"
        onError={() => setSourceFailed(true)}
        className="pointer-events-none absolute h-px w-px opacity-0"
      />
      {slots.map((key, index) => {
        const state: FrameState | "pending" =
          states.get(key) ?? (sourceFailed ? "placeholder" : "pending");
        return (
          <canvas
            key={`${index}-${key}`}
            ref={(element) => {
              tileRefs.current[index] = element;
            }}
            data-testid="video-frame"
            data-state={state}
            data-ms={key}
            width={FRAME_TILE_WIDTH_PX}
            height={FRAME_TILE_WIDTH_PX}
            className={`h-full flex-1 ${state === "ready" ? "" : state === "placeholder" ? "bg-stone-300" : "bg-stone-200"}`}
          />
        );
      })}
    </div>
  );
}
