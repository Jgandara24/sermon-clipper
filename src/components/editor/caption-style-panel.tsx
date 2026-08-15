"use client";

import { Move, Type } from "lucide-react";
import {
  CAPTION_PRESETS,
  CAPTION_STYLE_LIMITS,
  clampToLimit,
} from "@/lib/editor/caption-presets";
import { resolveCaptionStyle } from "@/lib/editor/caption-style";
import { CAPTION_FONTS } from "@/lib/editor/fonts";
import type { EditorState } from "@/lib/editor/types";
import { StyleSlider } from "@/components/editor/style-slider";

type Captions = EditorState["captions"];
type Overrides = Captions["overrides"];

const FONT_WEIGHTS = [400, 600, 700, 800] as const;

/**
 * Caption styling controls. Each group's Reset deletes only that group's override keys, so
 * "back to preset" is per-concern rather than all-or-nothing. Values written here are
 * overrides on top of the preset — resolveCaptionStyle merges and clamps them identically for
 * this panel, the live preview, and the render.
 */
export function CaptionStylePanel({
  captions,
  onChange,
  onInteractionStart,
  onInteractionEnd,
}: {
  captions: Captions;
  onChange: (next: Captions) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}) {
  const style = resolveCaptionStyle(captions.presetId, captions.overrides);
  const interactionProps = { onInteractionStart, onInteractionEnd };

  function setOverrides(patch: Partial<Overrides>) {
    onChange({ ...captions, overrides: { ...captions.overrides, ...patch } });
  }

  function resetKeys(keys: Array<keyof Overrides>) {
    const next = { ...captions.overrides };
    for (const key of keys) delete next[key];
    onChange({ ...captions, overrides: next });
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <Type size={18} className="text-red-600" aria-hidden="true" />
        <h2 className="font-semibold">Captions</h2>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {CAPTION_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => onChange({ ...captions, presetId: preset.id })}
            className={`rounded-md border px-2 py-2 text-xs font-medium ${
              captions.presetId === preset.id
                ? "border-red-600 bg-red-50 text-red-700"
                : "border-stone-300 text-stone-600 hover:bg-stone-50"
            }`}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <StyleGroup
        title="Typography"
        onReset={() => resetKeys(["fontFamily", "fontWeight", "sizePx", "textColor", "uppercase"])}
      >
        <label className="text-xs text-stone-600">
          Font
          <select
            value={captions.overrides.fontFamily ?? ""}
            onChange={(event) => setOverrides({ fontFamily: event.target.value || undefined })}
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5"
          >
            <option value="">Preset default</option>
            {CAPTION_FONTS.map((font) => (
              <option key={font.id} value={font.id}>
                {font.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-600">
          Weight
          <select
            value={captions.overrides.fontWeight ?? ""}
            onChange={(event) =>
              setOverrides({ fontWeight: event.target.value ? Number(event.target.value) : undefined })
            }
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5"
          >
            <option value="">Preset default</option>
            {FONT_WEIGHTS.map((weight) => (
              <option key={weight} value={weight}>
                {weight}
              </option>
            ))}
          </select>
        </label>
        <StyleSlider
          label="Size"
          min={CAPTION_STYLE_LIMITS.sizePx.min}
          max={CAPTION_STYLE_LIMITS.sizePx.max}
          step={CAPTION_STYLE_LIMITS.sizePx.step}
          value={style.sizePx}
          unit="px"
          onCommit={(sizePx) => setOverrides({ sizePx })}
          {...interactionProps}
        />
        <ColorField
          label="Text color"
          value={style.textColor}
          onChange={(textColor) => setOverrides({ textColor })}
          {...interactionProps}
        />
        <label className="flex items-center gap-2 text-xs text-stone-600">
          <input
            type="checkbox"
            checked={style.uppercase}
            onChange={(event) => setOverrides({ uppercase: event.target.checked })}
          />
          Uppercase
        </label>
      </StyleGroup>

      <StyleGroup
        title="Highlight"
        onReset={() => resetKeys(["highlightMode", "highlightColor", "highlightScale"])}
      >
        <label className="text-xs text-stone-600">
          Active word
          <select
            value={captions.overrides.highlightMode ?? ""}
            onChange={(event) =>
              setOverrides({
                highlightMode: event.target.value ? (event.target.value as "none" | "word") : undefined,
              })
            }
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5"
          >
            <option value="">Preset default</option>
            <option value="none">Off</option>
            <option value="word">Highlight each word</option>
          </select>
        </label>
        <ColorField
          label="Highlight color"
          value={style.highlightColor}
          onChange={(highlightColor) => setOverrides({ highlightColor })}
          {...interactionProps}
        />
        <StyleSlider
          label="Pop"
          min={CAPTION_STYLE_LIMITS.highlightScale.min}
          max={CAPTION_STYLE_LIMITS.highlightScale.max}
          step={CAPTION_STYLE_LIMITS.highlightScale.step}
          value={style.highlightScale}
          unit="%"
          toDisplayValue={(v) => Math.round((v - 1) * 100)}
          fromDisplayValue={(v) => 1 + v / 100}
          onCommit={(highlightScale) => setOverrides({ highlightScale })}
          {...interactionProps}
        />
        <p className="text-[11px] text-stone-500 sm:col-span-2">
          Word clearance grows automatically with Pop. Caption words stay fixed during playback.
        </p>
      </StyleGroup>

      <StyleGroup
        title="Stroke &amp; shadow"
        onReset={() =>
          resetKeys(["outlineColor", "outlineWidthPx", "shadowColor", "shadowDistancePx"])
        }
      >
        <ColorField
          label="Outline color"
          value={style.outlineColor}
          onChange={(outlineColor) => setOverrides({ outlineColor })}
          {...interactionProps}
        />
        <StyleSlider
          label="Outline width"
          min={CAPTION_STYLE_LIMITS.outlineWidthPx.min}
          max={CAPTION_STYLE_LIMITS.outlineWidthPx.max}
          step={CAPTION_STYLE_LIMITS.outlineWidthPx.step}
          value={style.outlineWidthPx}
          unit="px"
          onCommit={(outlineWidthPx) => setOverrides({ outlineWidthPx })}
          {...interactionProps}
        />
        <ColorField
          label="Shadow color"
          value={style.shadowColor}
          onChange={(shadowColor) => setOverrides({ shadowColor })}
          {...interactionProps}
        />
        <StyleSlider
          label="Shadow distance"
          min={CAPTION_STYLE_LIMITS.shadowDistancePx.min}
          max={CAPTION_STYLE_LIMITS.shadowDistancePx.max}
          step={CAPTION_STYLE_LIMITS.shadowDistancePx.step}
          value={style.shadowDistancePx}
          unit="px"
          onCommit={(shadowDistancePx) => setOverrides({ shadowDistancePx })}
          {...interactionProps}
        />
      </StyleGroup>

      <StyleGroup
        title="Position"
        onReset={() =>
          resetKeys(["positionX", "positionY", "safeAnchor", "anchor", "position"])
        }
      >
        <div className="sm:col-span-2">
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-stone-100 p-1">
            {([
              ["top-safe", "Top safe"],
              ["center", "Center"],
              ["bottom-safe", "Bottom safe"],
            ] as const).map(([safeAnchor, label]) => (
              <button
                key={safeAnchor}
                type="button"
                onClick={() =>
                  setOverrides({ safeAnchor, positionX: 50, anchor: "center" })
                }
                className={`rounded-md px-2 py-2 text-[11px] font-semibold ${
                  style.safeAnchor === safeAnchor
                    ? "bg-red-600 text-white shadow-sm"
                    : "text-stone-600 hover:bg-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <PositionNumber
          label="X position"
          value={style.positionX}
          onChange={(positionX) => setOverrides({ positionX, safeAnchor: "custom" })}
          {...interactionProps}
        />
        <PositionNumber
          label="Y position"
          value={style.positionY}
          onChange={(positionY) =>
            setOverrides({ positionY, anchor: "center", safeAnchor: "custom" })
          }
          {...interactionProps}
        />
        <p className="flex items-center gap-2 text-[11px] text-stone-500 sm:col-span-2">
          <Move size={13} aria-hidden="true" />
          Click the captions on the video, then drag them anywhere. Unsafe placement shows a warning.
        </p>
      </StyleGroup>
    </div>
  );
}

function StyleGroup({
  title,
  onReset,
  children,
}: {
  title: string;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4 border-t border-stone-100 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">{title}</h3>
        <button
          type="button"
          onClick={onReset}
          className="text-[11px] font-medium text-red-700 hover:underline"
        >
          Reset
        </button>
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function PositionNumber({
  label,
  value,
  onChange,
  onInteractionStart,
  onInteractionEnd,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}) {
  return (
    <label className="text-xs text-stone-600">
      {label}
      <span className="mt-1 flex overflow-hidden rounded-md border border-stone-300 bg-white focus-within:border-red-500 focus-within:ring-1 focus-within:ring-red-500">
        <input
          type="number"
          min={0}
          max={100}
          step={0.5}
          value={value}
          onFocus={onInteractionStart}
          onBlur={onInteractionEnd}
          onChange={(event) =>
            onChange(clampToLimit(Number(event.target.value), CAPTION_STYLE_LIMITS.positionX))
          }
          className="min-w-0 flex-1 px-2 py-1.5 text-right font-semibold tabular-nums text-stone-900 outline-none"
        />
        <span className="border-l border-stone-200 px-2 py-1.5 text-[10px] text-stone-400">%</span>
      </span>
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange,
  onInteractionStart,
  onInteractionEnd,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}) {
  return (
    <label className="text-xs text-stone-600">
      {label}
      <input
        type="color"
        value={value.toLowerCase()}
        onFocus={onInteractionStart}
        onBlur={onInteractionEnd}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-8 w-full rounded-md border border-stone-300"
      />
    </label>
  );
}
