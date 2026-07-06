"use client";

import { Type } from "lucide-react";
import { CAPTION_PRESETS } from "@/lib/editor/caption-presets";
import type { EditorState } from "@/lib/editor/types";

type Captions = EditorState["captions"];

export function CaptionStylePanel({
  captions,
  onChange,
}: {
  captions: Captions;
  onChange: (next: Captions) => void;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <Type size={18} className="text-teal-800" aria-hidden="true" />
        <h2 className="font-semibold">Captions</h2>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {CAPTION_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onChange({ ...captions, presetId: preset.id })}
            className={`rounded-md border px-2 py-2 text-xs font-medium ${
              captions.presetId === preset.id
                ? "border-teal-700 bg-teal-50 text-teal-800"
                : "border-stone-300 text-stone-600 hover:bg-stone-50"
            }`}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-stone-600">
          Position
          <select
            value={captions.overrides.position ?? ""}
            onChange={(event) =>
              onChange({
                ...captions,
                overrides: {
                  ...captions.overrides,
                  position: event.target.value
                    ? (event.target.value as "top" | "middle" | "bottom")
                    : undefined,
                },
              })
            }
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5"
          >
            <option value="">Preset default</option>
            <option value="top">Top</option>
            <option value="middle">Middle</option>
            <option value="bottom">Bottom</option>
          </select>
        </label>

        <label className="text-xs text-stone-600">
          Size (px)
          <input
            type="number"
            min={16}
            max={160}
            value={captions.overrides.sizePx ?? ""}
            placeholder="Preset default"
            onChange={(event) =>
              onChange({
                ...captions,
                overrides: {
                  ...captions.overrides,
                  sizePx: event.target.value ? Number(event.target.value) : undefined,
                },
              })
            }
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5"
          />
        </label>

        <label className="flex items-center gap-2 text-xs text-stone-600">
          <input
            type="checkbox"
            checked={captions.overrides.uppercase ?? false}
            onChange={(event) =>
              onChange({
                ...captions,
                overrides: { ...captions.overrides, uppercase: event.target.checked },
              })
            }
          />
          Uppercase
        </label>

        <label className="text-xs text-stone-600">
          Highlight color
          <input
            type="color"
            value={captions.overrides.highlightColor ?? "#ffd34d"}
            onChange={(event) =>
              onChange({
                ...captions,
                overrides: { ...captions.overrides, highlightColor: event.target.value },
              })
            }
            className="mt-1 h-8 w-full rounded-md border border-stone-300"
          />
        </label>
      </div>
    </div>
  );
}
