"use client";

import { Volume2 } from "lucide-react";
import { clampToRange, parseNumericInput, type NumericRange } from "@/lib/editor/numeric-field";
import type { CommitMode } from "@/lib/editor/save-scheduler";
import type { EditorState } from "@/lib/editor/types";

type Audio = EditorState["audio"];

/**
 * Shown and edited as a percentage of the source's own level. The document stores a factor and
 * allows up to 2, but the control stops at 100: the preview's video element cannot play louder
 * than the source, and a control the preview cannot show is the defect this editor exists to
 * prevent. A boost waits until the preview can play one.
 */
const VOLUME_PERCENT_RANGE: NumericRange = { min: 0, max: 100, step: 1 };

export function volumeToPercent(originalVolume: number): number {
  return Math.round(clampToRange(originalVolume * 100, VOLUME_PERCENT_RANGE));
}

/**
 * The Audio settings: how loud the sermon's own sound is.
 *
 * The slider reports on `idle`, so dragging it changes the preview on every frame and saves once
 * when the pointer lifts — the same instant preview / coalesced save split every other panel uses.
 */
export function AudioPanel({
  audio,
  onChange,
  onCommit,
}: {
  audio: Audio;
  onChange: (next: Audio, mode: CommitMode) => void;
  /** Writes whatever is pending. Sends nothing when nothing changed. */
  onCommit: () => void;
}) {
  const percent = volumeToPercent(audio.originalVolume);

  function setPercent(next: number, mode: CommitMode) {
    onChange({ ...audio, originalVolume: clampToRange(next, VOLUME_PERCENT_RANGE) / 100 }, mode);
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <Volume2 size={18} className="text-teal-800" aria-hidden="true" />
        <h2 className="font-semibold">Audio</h2>
      </div>
      <p className="mt-2 text-xs text-stone-500">
        How loud the sermon&apos;s own sound is. The preview plays it at this level.
      </p>

      <div className="mt-3 text-xs text-stone-600">
        <div className="flex items-center justify-between">
          <label htmlFor="audio-original-volume-slider">Original volume (%)</label>
          <input
            type="number"
            aria-label="Original volume value"
            min={VOLUME_PERCENT_RANGE.min}
            max={VOLUME_PERCENT_RANGE.max}
            step={VOLUME_PERCENT_RANGE.step}
            value={percent}
            onChange={(event) =>
              setPercent(parseNumericInput(event.target.value, VOLUME_PERCENT_RANGE, percent) ?? percent, "idle")
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommit();
            }}
            onBlur={onCommit}
            className="w-20 rounded-md border border-stone-300 px-2 py-1 text-right"
          />
        </div>
        <input
          id="audio-original-volume-slider"
          type="range"
          aria-label="Original volume"
          min={VOLUME_PERCENT_RANGE.min}
          max={VOLUME_PERCENT_RANGE.max}
          step={VOLUME_PERCENT_RANGE.step}
          value={percent}
          onChange={(event) => setPercent(Number(event.target.value), "idle")}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
          className="mt-1 w-full"
        />
      </div>
    </div>
  );
}
