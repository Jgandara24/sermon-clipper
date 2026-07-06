"use client";

import { LayoutTemplate } from "lucide-react";
import type { EditorState } from "@/lib/editor/types";

type Layout = EditorState["layout"];

const MODES: Array<{ value: Layout["mode"]; label: string; description: string }> = [
  { value: "center", label: "Center", description: "Static center crop" },
  { value: "face", label: "Face", description: "Tracks the speaker at render time" },
  { value: "manual", label: "Manual", description: "Choose your own crop box" },
];

export function LayoutPanel({
  layout,
  onChange,
}: {
  layout: Layout;
  onChange: (next: Layout) => void;
}) {
  function updateCrop(partial: Partial<Layout["crop"]>) {
    onChange({ ...layout, crop: { ...layout.crop, ...partial } });
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <LayoutTemplate size={18} className="text-teal-800" aria-hidden="true" />
        <h2 className="font-semibold">Layout</h2>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            onClick={() => onChange({ ...layout, mode: mode.value })}
            title={mode.description}
            className={`rounded-md border px-2 py-2 text-xs font-medium ${
              layout.mode === mode.value
                ? "border-teal-700 bg-teal-50 text-teal-800"
                : "border-stone-300 text-stone-600 hover:bg-stone-50"
            }`}
          >
            {mode.label}
          </button>
        ))}
      </div>

      {layout.mode === "manual" ? (
        <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-stone-600">
          <label>
            X {Math.round(layout.crop.x * 100)}%
            <input
              type="range"
              min={0}
              max={1 - layout.crop.w}
              step={0.01}
              value={layout.crop.x}
              onChange={(event) => updateCrop({ x: Number(event.target.value) })}
              className="mt-1 w-full"
            />
          </label>
          <label>
            Y {Math.round(layout.crop.y * 100)}%
            <input
              type="range"
              min={0}
              max={1 - layout.crop.h}
              step={0.01}
              value={layout.crop.y}
              onChange={(event) => updateCrop({ y: Number(event.target.value) })}
              className="mt-1 w-full"
            />
          </label>
          <label>
            Width {Math.round(layout.crop.w * 100)}%
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.01}
              value={layout.crop.w}
              onChange={(event) => updateCrop({ w: Number(event.target.value) })}
              className="mt-1 w-full"
            />
          </label>
          <label>
            Height {Math.round(layout.crop.h * 100)}%
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.01}
              value={layout.crop.h}
              onChange={(event) => updateCrop({ h: Number(event.target.value) })}
              className="mt-1 w-full"
            />
          </label>
        </div>
      ) : null}
      {layout.mode === "face" ? (
        <p className="mt-3 text-xs text-stone-500">
          Face tracking runs when the clip is exported — this preview shows a center crop as a
          stand-in.
        </p>
      ) : null}
    </div>
  );
}
