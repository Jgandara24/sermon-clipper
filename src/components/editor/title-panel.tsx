"use client";

import { Heading, X } from "lucide-react";
import { clampToRange, parseNumericInput, type NumericRange } from "@/lib/editor/numeric-field";
import type { CommitMode } from "@/lib/editor/save-scheduler";
import { TEXT_CASE_OPTIONS, type TextCase } from "@/lib/editor/text-case";
import {
  defaultTitleBanner,
  dismissTitleBanner,
  readTitleBanner,
  upsertTitleBanner,
  type TitleBanner,
} from "@/lib/editor/title-banner";

const SIZE_RANGE: NumericRange = { min: 16, max: 200, step: 1 };
const WEIGHT_RANGE: NumericRange = { min: 100, max: 900, step: 100 };
const BORDER_RANGE: NumericRange = { min: 0, max: 20, step: 1 };
const WIDTH_RANGE: NumericRange = { min: 10, max: 100, step: 1 };

const ANCHORS: ReadonlyArray<{ value: TitleBanner["anchor"]; label: string }> = [
  { value: "top-safe", label: "Top safe" },
  { value: "center", label: "Centre" },
  { value: "bottom-safe", label: "Bottom safe" },
];

const ALIGNMENTS: ReadonlyArray<{ value: TitleBanner["align"]; label: string }> = [
  { value: "left", label: "Left" },
  { value: "center", label: "Centre" },
  { value: "right", label: "Right" },
];

/**
 * The Title settings.
 *
 * Every control writes through `upsertTitleBanner`, which validates, so nothing this panel can do
 * puts an invalid title in the document. Sliders and colour inputs report on `idle` so dragging
 * through them updates the preview on every frame and saves once at the end — the same instant
 * preview / coalesced save split the caption controls use.
 */
export function TitlePanel({
  overlays,
  clip,
  onChange,
  onCommit,
}: {
  overlays: unknown[];
  clip: { startMs: number; endMs: number };
  onChange: (next: unknown[], mode: CommitMode) => void;
  onCommit: () => void;
}) {
  const title = readTitleBanner(overlays);

  function write(next: TitleBanner, mode: CommitMode) {
    onChange(upsertTitleBanner(overlays, next), mode);
  }

  function set(patch: Partial<TitleBanner>, mode: CommitMode) {
    if (!title) return;
    write({ ...title, ...patch }, mode);
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Heading size={18} className="text-teal-800" aria-hidden="true" />
          <h2 className="font-semibold">Title</h2>
        </div>
        {title ? (
          <button
            type="button"
            aria-label="Remove title"
            data-testid="title-remove"
            onClick={() => {
              // Dismissed, not merely removed: without the marker anything that ensures a default
              // would put it straight back and the member would remove it on every load.
              onChange(dismissTitleBanner(overlays), "immediate");
              onCommit();
            }}
            className="rounded-md p-1 text-stone-500 hover:bg-stone-100 hover:text-stone-800"
          >
            <X size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {!title ? (
        <div className="mt-3">
          <p className="text-sm text-stone-600">This clip has no title.</p>
          <button
            type="button"
            data-testid="title-add"
            title="Add a three-second title at the top of the clip"
            onClick={() => {
              write(defaultTitleBanner(clip), "immediate");
              onCommit();
            }}
            className="mt-2 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-50"
          >
            Add title
          </button>
        </div>
      ) : (
        <div className="mt-3 grid gap-4">
          <label className="grid gap-1 text-sm">
            <span className="font-medium">Text</span>
            <input
              type="text"
              data-testid="title-text"
              value={title.text}
              maxLength={200}
              onChange={(event) => set({ text: event.target.value }, "idle")}
              onBlur={onCommit}
              className="rounded-md border border-stone-300 px-2 py-1.5"
            />
          </label>

          <Choice
            label="Position"
            options={ANCHORS}
            value={title.anchor === "custom" ? null : title.anchor}
            hint={title.anchor === "custom" ? "Dragged to its own place" : undefined}
            onPick={(anchor) => {
              // Choosing a position discards a dragged point, which is what choosing one means.
              set({ anchor, box: undefined }, "immediate");
              onCommit();
            }}
          />

          <Choice
            label="Alignment"
            options={ALIGNMENTS}
            value={title.align}
            onPick={(align) => {
              set({ align }, "immediate");
              onCommit();
            }}
          />

          <label className="grid gap-1 text-sm">
            <span className="font-medium">Case</span>
            <select
              data-testid="title-case"
              value={title.textCase}
              onChange={(event) => {
                set({ textCase: event.target.value as TextCase }, "immediate");
                onCommit();
              }}
              className="rounded-md border border-stone-300 px-2 py-1.5"
            >
              {TEXT_CASE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <Slider
            label="Size"
            testId="title-size"
            range={SIZE_RANGE}
            value={title.sizePx}
            onInput={(sizePx) => set({ sizePx }, "idle")}
            onCommit={onCommit}
          />
          <Slider
            label="Weight"
            testId="title-weight"
            range={WEIGHT_RANGE}
            value={title.weight}
            onInput={(weight) => set({ weight }, "idle")}
            onCommit={onCommit}
          />
          <Slider
            label="Width"
            testId="title-width"
            range={WIDTH_RANGE}
            value={Math.round(title.widthPct * 100)}
            suffix="%"
            onInput={(percent) => set({ widthPct: percent / 100 }, "idle")}
            onCommit={onCommit}
          />

          <div className="grid grid-cols-2 gap-3">
            <Colour
              label="Text"
              testId="title-color"
              value={title.color}
              onInput={(color) => set({ color }, "idle")}
              onCommit={onCommit}
            />
            <Colour
              label="Background"
              testId="title-background"
              value={title.backgroundColor}
              onInput={(backgroundColor) => set({ backgroundColor }, "idle")}
              onCommit={onCommit}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Slider
              label="Border"
              testId="title-border-width"
              range={BORDER_RANGE}
              value={title.border.widthPx}
              onInput={(widthPx) => set({ border: { ...title.border, widthPx } }, "idle")}
              onCommit={onCommit}
            />
            <Colour
              label="Border colour"
              testId="title-border-color"
              value={title.border.color}
              onInput={(color) => set({ border: { ...title.border, color } }, "idle")}
              onCommit={onCommit}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="title-shadow"
              checked={title.shadow}
              onChange={(event) => {
                set({ shadow: event.target.checked }, "immediate");
                onCommit();
              }}
            />
            Drop shadow
          </label>
        </div>
      )}
    </div>
  );
}

function Choice<T extends string>({
  label,
  options,
  value,
  hint,
  onPick,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  hint?: string;
  onPick: (value: T) => void;
}) {
  return (
    <div className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <div className="flex gap-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            title={`${label}: ${option.label}`}
            aria-pressed={value === option.value}
            data-testid={`title-${label.toLowerCase()}-${option.value}`}
            onClick={() => onPick(option.value)}
            className={`flex-1 rounded-md border px-2 py-1.5 text-sm ${
              value === option.value
                ? "border-teal-700 bg-teal-50 font-medium text-teal-900"
                : "border-stone-300 hover:bg-stone-50"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {hint ? <span className="text-xs text-stone-500">{hint}</span> : null}
    </div>
  );
}

function Slider({
  label,
  testId,
  range,
  value,
  suffix,
  onInput,
  onCommit,
}: {
  label: string;
  testId: string;
  range: NumericRange;
  value: number;
  suffix?: string;
  onInput: (value: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">
        {label}
        <span className="ml-2 font-normal text-stone-500">
          {value}
          {suffix ?? ""}
        </span>
      </span>
      <input
        type="range"
        data-testid={testId}
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        // Every frame of the drag reaches the preview; the save is coalesced behind it.
        onChange={(event) => {
          // A range input cannot be empty, but the parser can still answer undefined for a value
          // that is not a number at all, and that must not be written as one.
          const parsed = parseNumericInput(event.target.value, range, value);
          if (parsed !== undefined) onInput(clampToRange(parsed, range));
        }}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
    </label>
  );
}

function Colour({
  label,
  testId,
  value,
  onInput,
  onCommit,
}: {
  label: string;
  testId: string;
  value: string;
  onInput: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        type="color"
        data-testid={testId}
        value={value}
        // A colour picker fires while the member drags through it, and the preview follows.
        onChange={(event) => onInput(event.target.value.toUpperCase())}
        onBlur={onCommit}
        className="h-9 w-full rounded-md border border-stone-300"
      />
    </label>
  );
}
