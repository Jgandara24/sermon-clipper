"use client";

import { Volume2, X } from "lucide-react";
import { StyleSlider } from "@/components/editor/style-slider";

export function AudioTrackPanel({
  volume,
  onChange,
  onClose,
  onInteractionStart,
  onInteractionEnd,
}: {
  volume: number;
  onChange: (volume: number) => void;
  onClose: () => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}) {
  return (
    <section className="rounded-lg border border-stone-200 bg-white shadow-sm" aria-label="Audio settings">
      <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <Volume2 size={17} className="text-red-600" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-stone-900">Audio settings</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-2 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          aria-label="Close audio settings"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="grid gap-4 p-4">
        <StyleSlider
          label="Original audio"
          min={0}
          max={1}
          step={0.01}
          value={Math.min(1, Math.max(0, volume))}
          unit="%"
          toDisplayValue={(value) => Math.round(value * 100)}
          fromDisplayValue={(value) => value / 100}
          onCommit={onChange}
          onInteractionStart={onInteractionStart}
          onInteractionEnd={onInteractionEnd}
        />
        <p className="text-xs leading-5 text-stone-500">
          This controls the source audio in the preview and exported MP4.
        </p>
      </div>
    </section>
  );
}
