"use client";

import { ChevronDown, ChevronRight, Type } from "lucide-react";
import { useState } from "react";
import {
  getCaptionPreset,
  SELECTABLE_CAPTION_PRESETS,
} from "@/lib/editor/caption-presets";
import {
  clampToRange,
  displayedValue,
  parseNumericInput,
  type NumericRange,
} from "@/lib/editor/numeric-field";
import type { CommitMode } from "@/lib/editor/save-scheduler";
import { resolveTextCase, TEXT_CASE_OPTIONS, type TextCase } from "@/lib/editor/text-case";
import type { EditorState } from "@/lib/editor/types";

type Captions = EditorState["captions"];

const SIZE_RANGE: NumericRange = { min: 16, max: 160, step: 1 };
const WEIGHT_RANGE: NumericRange = { min: 100, max: 900, step: 100 };
const STROKE_RANGE: NumericRange = { min: 0, max: 20, step: 1 };

/** Faces that exist on the render host as well as in the browser, so the two agree. */
const FONT_OPTIONS = [
  { value: "Inter, system-ui, sans-serif", label: "Inter" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia" },
  { value: "'Arial Black', Arial, sans-serif", label: "Arial Black" },
  { value: "'Courier New', monospace", label: "Courier New" },
];

export function CaptionStylePanel({
  captions,
  onChange,
  onCommit,
}: {
  captions: Captions;
  onChange: (next: Captions, mode: CommitMode) => void;
  /** Writes whatever is pending. Sends nothing when nothing changed. */
  onCommit: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const preset = getCaptionPreset(captions.presetId).style;

  function setOverrides(next: Partial<Captions["overrides"]>, mode: CommitMode) {
    onChange({ ...captions, overrides: { ...captions.overrides, ...next } }, mode);
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <Type size={18} className="text-teal-800" aria-hidden="true" />
        <h2 className="font-semibold">Captions</h2>
      </div>

      {/*
        Only the presets still on offer. A clip saved against a retired one keeps rendering it —
        hiding a preset from the picker is not a reason to change what a church already approved.
      */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        {SELECTABLE_CAPTION_PRESETS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={captions.presetId === option.id}
            onClick={() => onChange({ ...captions, presetId: option.id }, "immediate")}
            className={`rounded-md border px-2 py-2 text-xs font-medium ${
              captions.presetId === option.id
                ? "border-teal-700 bg-teal-50 text-teal-800"
                : "border-stone-300 text-stone-600 hover:bg-stone-50"
            }`}
          >
            {option.name}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {/* Font belongs with the everyday choices, not behind a disclosure. */}
        <label className="text-xs text-stone-600">
          Font
          <select
            value={captions.overrides.fontFamily ?? preset.fontFamily}
            onChange={(event) => setOverrides({ fontFamily: event.target.value }, "immediate")}
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5"
          >
            {FONT_OPTIONS.map((font) => (
              <option key={font.value} value={font.value}>
                {font.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs text-stone-600">
          Text case
          <select
            value={resolveTextCase({
              textCase: captions.overrides.textCase,
              legacyUppercase: captions.overrides.uppercase,
              fallback: preset.textCase,
            })}
            onChange={(event) =>
              setOverrides(
                {
                  textCase: event.target.value as TextCase,
                  // The old boolean is dropped on write: the explicit case says everything, and
                  // leaving it behind would keep two sources of truth in one document.
                  uppercase: undefined,
                },
                "immediate",
              )
            }
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5"
          >
            {TEXT_CASE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 grid gap-3">
        <SliderField
          label="Size"
          unit="px"
          range={SIZE_RANGE}
          override={captions.overrides.sizePx}
          presetValue={preset.sizePx}
          onChange={(value, mode) => setOverrides({ sizePx: value }, mode)}
          onCommit={onCommit}
        />
        <SliderField
          label="Weight"
          range={WEIGHT_RANGE}
          override={captions.overrides.weight}
          presetValue={preset.weight}
          onChange={(value, mode) => setOverrides({ weight: value }, mode)}
          onCommit={onCommit}
        />
      </div>

      {/*
        Position is the frame-level choice; where exactly the caption sits is a drag on the video.
        There are no X and Y fields — direct manipulation is the position control.
      */}
      <label className="mt-3 block text-xs text-stone-600">
        Position
        <select
          value={captions.overrides.position ?? ""}
          onChange={(event) =>
            setOverrides(
              {
                position: event.target.value
                  ? (event.target.value as "top" | "middle" | "bottom")
                  : undefined,
              },
              "immediate",
            )
          }
          className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5"
        >
          <option value="">Preset default</option>
          <option value="top">Top</option>
          <option value="middle">Middle</option>
          <option value="bottom">Bottom safe</option>
        </select>
      </label>

      <div className="mt-4 border-t border-stone-200 pt-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          aria-controls="caption-advanced-styling"
          className="flex w-full items-center gap-1.5 text-xs font-medium text-stone-700 hover:text-stone-900"
        >
          {advancedOpen ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          Advanced styling
          <span className="ml-auto font-normal text-stone-500">
            {advancedOpen ? "Hide" : "Show"}
          </span>
        </button>

        {advancedOpen ? (
          <div id="caption-advanced-styling" className="mt-3 grid gap-3">
            <label className="text-xs text-stone-600">
              Highlight colour
              <input
                type="color"
                value={captions.overrides.highlightColor ?? preset.highlightColor}
                onChange={(event) =>
                  setOverrides({ highlightColor: event.target.value }, "idle")
                }
                onBlur={onCommit}
                className="mt-1 h-8 w-full rounded-md border border-stone-300"
              />
            </label>

            <SliderField
              label="Outline"
              unit="px"
              range={STROKE_RANGE}
              override={captions.overrides.strokePx}
              presetValue={preset.strokePx}
              onChange={(value, mode) => setOverrides({ strokePx: value }, mode)}
              onCommit={onCommit}
            />

            <label className="text-xs text-stone-600">
              Background
              <select
                value={captions.overrides.background ?? preset.background}
                onChange={(event) =>
                  setOverrides(
                    { background: event.target.value as "none" | "pill" },
                    "immediate",
                  )
                }
                className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5"
              >
                <option value="none">None</option>
                <option value="pill">Pill</option>
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs text-stone-600">
              <input
                type="checkbox"
                checked={captions.overrides.shadow ?? preset.shadow}
                onChange={(event) => setOverrides({ shadow: event.target.checked }, "immediate")}
              />
              Drop shadow
            </label>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A slider and a number field showing one value.
 *
 * Both write through the same handler, so they cannot drift: whichever one the member touches, the
 * other re-renders from the value that was just written. The slider emits `idle` frames while it is
 * being dragged and commits on release; the field commits on Enter or on leaving it.
 */
function SliderField({
  label,
  unit,
  range,
  override,
  presetValue,
  onChange,
  onCommit,
}: {
  label: string;
  unit?: string;
  range: NumericRange;
  override: number | undefined;
  presetValue: number;
  onChange: (value: number | undefined, mode: CommitMode) => void;
  onCommit: () => void;
}) {
  const value = clampToRange(displayedValue(override, presetValue), range);

  return (
    <div className="text-xs text-stone-600">
      <div className="flex items-center justify-between">
        <label htmlFor={`caption-${label.toLowerCase()}-slider`}>
          {label}
          {unit ? ` (${unit})` : ""}
        </label>
        <input
          type="number"
          aria-label={`${label} value`}
          min={range.min}
          max={range.max}
          step={range.step}
          value={value}
          onChange={(event) =>
            onChange(parseNumericInput(event.target.value, range, override), "idle")
          }
          onKeyDown={(event) => {
            if (event.key === "Enter") onCommit();
          }}
          onBlur={onCommit}
          className="w-20 rounded-md border border-stone-300 px-2 py-1 text-right"
        />
      </div>
      <input
        id={`caption-${label.toLowerCase()}-slider`}
        type="range"
        aria-label={label}
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value), "idle")}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        className="mt-1 w-full"
      />
    </div>
  );
}
