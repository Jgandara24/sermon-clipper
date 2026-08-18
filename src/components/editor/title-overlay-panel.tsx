"use client";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Italic,
  Trash2,
  Type,
  Underline,
  X,
} from "lucide-react";
import { StyleSlider } from "@/components/editor/style-slider";
import { CAPTION_FONTS } from "@/lib/editor/fonts";
import type { TitleBannerOverlay } from "@/lib/editor/title-banner";

const FONT_WEIGHTS = [400, 600, 700, 800] as const;

export function TitleOverlayPanel({
  banner,
  onChange,
  onClose,
  onRemove,
  onInteractionStart,
  onInteractionEnd,
}: {
  banner: TitleBannerOverlay;
  onChange: (banner: TitleBannerOverlay) => void;
  onClose: () => void;
  onRemove: () => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}) {
  const interactionProps = { onInteractionStart, onInteractionEnd };

  return (
    <section className="rounded-lg border border-stone-200 bg-white shadow-sm" aria-label="Title overlay settings">
      <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <Type size={17} className="text-red-600" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-stone-900">Title overlay settings</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-2 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          aria-label="Close title settings"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="grid gap-4 p-4">
        <button
          type="button"
          onClick={onRemove}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-md border border-red-200 bg-red-50 text-xs font-semibold text-red-700 hover:border-red-300 hover:bg-red-100"
        >
          <Trash2 size={15} aria-hidden="true" />
          Remove title
        </button>

        <label className="text-xs font-medium text-stone-600">
          Input
          <textarea
            value={banner.text}
            maxLength={120}
            rows={3}
            onFocus={onInteractionStart}
            onBlur={onInteractionEnd}
            onChange={(event) => onChange({ ...banner, text: event.target.value })}
            className="mt-1.5 w-full resize-none rounded-md border border-stone-300 bg-stone-50 px-3 py-2 text-sm text-stone-900 outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500"
          />
        </label>

        <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
          <label className="text-xs font-medium text-stone-600">
            Font
            <select
              value={banner.fontFamily}
              onChange={(event) => onChange({ ...banner, fontFamily: event.target.value })}
              className="mt-1.5 w-full rounded-md border border-stone-300 px-2 py-2"
            >
              {CAPTION_FONTS.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-stone-600">
            Weight
            <select
              value={banner.fontWeight}
              onChange={(event) => onChange({ ...banner, fontWeight: Number(event.target.value) })}
              className="mt-1.5 w-full rounded-md border border-stone-300 px-2 py-2"
            >
              {FONT_WEIGHTS.map((weight) => (
                <option key={weight} value={weight}>
                  {weight}
                </option>
              ))}
            </select>
          </label>
        </div>

        <StyleSlider
          label="Size"
          min={16}
          max={120}
          step={1}
          value={banner.fontSizePx}
          unit="px"
          onCommit={(fontSizePx) => onChange({ ...banner, fontSizePx })}
          {...interactionProps}
        />

        <div className="grid grid-cols-2 gap-3">
          <ColorField
            label="Text color"
            value={banner.textColor}
            onChange={(textColor) => onChange({ ...banner, textColor })}
          />
          <ColorField
            label="Background"
            value={banner.backgroundColor}
            onChange={(backgroundColor) => onChange({ ...banner, backgroundColor })}
          />
        </div>

        <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-stone-500">
            Position
          </p>
          <div className="grid gap-3">
            <StyleSlider
              label="Horizontal"
              min={5}
              max={95}
              step={0.5}
              value={banner.positionX}
              unit="%"
              onCommit={(positionX) => onChange({ ...banner, positionX })}
              {...interactionProps}
            />
            <StyleSlider
              label="Vertical"
              min={5}
              max={95}
              step={0.5}
              value={banner.positionY}
              unit="%"
              onCommit={(positionY) => onChange({ ...banner, positionY })}
              {...interactionProps}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="mb-1.5 text-xs font-medium text-stone-600">Alignment</p>
            <div className="grid grid-cols-3 gap-1 rounded-md bg-stone-100 p-1">
              {([
                ["left", AlignLeft],
                ["center", AlignCenter],
                ["right", AlignRight],
              ] as const).map(([alignment, Icon]) => (
                <button
                  key={alignment}
                  type="button"
                  onClick={() => onChange({ ...banner, alignment })}
                  className={`flex h-9 items-center justify-center rounded ${
                    banner.alignment === alignment
                      ? "bg-white text-red-600 shadow-sm"
                      : "text-stone-500 hover:text-stone-900"
                  }`}
                  aria-label={`Align title ${alignment}`}
                >
                  <Icon size={16} aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-stone-600">Decoration</p>
            <div className="grid grid-cols-2 gap-1 rounded-md bg-stone-100 p-1">
              <ToggleButton
                label="Italic title"
                active={banner.italic}
                onClick={() => onChange({ ...banner, italic: !banner.italic })}
              >
                <Italic size={16} aria-hidden="true" />
              </ToggleButton>
              <ToggleButton
                label="Underline title"
                active={banner.underline}
                onClick={() => onChange({ ...banner, underline: !banner.underline })}
              >
                <Underline size={16} aria-hidden="true" />
              </ToggleButton>
            </div>
          </div>
        </div>

        <StyleSlider
          label="Corner radius"
          min={0}
          max={40}
          step={1}
          value={banner.borderRadiusPx}
          unit="px"
          onCommit={(borderRadiusPx) => onChange({ ...banner, borderRadiusPx })}
          {...interactionProps}
        />
        <div className="grid grid-cols-2 gap-3">
          <ColorField
            label="Border color"
            value={banner.borderColor}
            onChange={(borderColor) => onChange({ ...banner, borderColor })}
          />
          <ColorField
            label="Shadow color"
            value={banner.shadowColor}
            onChange={(shadowColor) => onChange({ ...banner, shadowColor })}
          />
        </div>
        <StyleSlider
          label="Border width"
          min={0}
          max={20}
          step={1}
          value={banner.borderWidthPx}
          unit="px"
          onCommit={(borderWidthPx) => onChange({ ...banner, borderWidthPx })}
          {...interactionProps}
        />
        <StyleSlider
          label="Shadow distance"
          min={0}
          max={30}
          step={1}
          value={banner.shadowDistancePx}
          unit="px"
          onCommit={(shadowDistancePx) => onChange({ ...banner, shadowDistancePx })}
          {...interactionProps}
        />
        <StyleSlider
          label="Width"
          min={30}
          max={100}
          step={1}
          value={banner.widthPct}
          unit="%"
          onCommit={(widthPct) => onChange({ ...banner, widthPct })}
          {...interactionProps}
        />
      </div>
    </section>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="text-xs font-medium text-stone-600">
      {label}
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 h-10 w-full rounded-md border border-stone-300 bg-white p-1"
      />
    </label>
  );
}

function ToggleButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-9 items-center justify-center rounded ${
        active ? "bg-white text-red-600 shadow-sm" : "text-stone-500 hover:text-stone-900"
      }`}
    >
      {children}
    </button>
  );
}
