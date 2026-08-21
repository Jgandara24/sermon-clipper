import type { TextCase } from "./text-case";

export type CaptionStyle = {
  fontFamily: string;
  sizePx: number;
  textColor: string;
  highlightColor: string;
  background: "none" | "pill";
  position: "top" | "middle" | "bottom";
  /** A dragged position, if the member has set one. Null means `position` decides. */
  box?: { xPct: number; yPct: number } | null;
  alignment: "left" | "center" | "right";
  /** CSS font weight, 100-900. The burn-in has only bold or not, so 600+ reads as bold. */
  weight: number;
  textCase: TextCase;
  strokeColor: string;
  strokePx: number;
  shadow: boolean;
};

export type CaptionPreset = {
  id: string;
  name: string;
  style: CaptionStyle;
  /**
   * False for a preset that is no longer offered but must still render. A clip saved against one
   * keeps its exact look — hiding a preset from the picker is not a reason to change what a church
   * already approved.
   */
  selectable: boolean;
};

/** Neon Yellow: the Highlighter preset's active-word colour. */
export const NEON_YELLOW = "#CCFF00";

// Original names/styles per guide §13 — never reuse a competitor's preset names.
export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: "clean",
    name: "Clean",
    style: {
      fontFamily: "Inter, system-ui, sans-serif",
      sizePx: 44,
      textColor: "#FFFFFF",
      highlightColor: "#2DD4BF",
      background: "none",
      position: "bottom",
      alignment: "center",
      weight: 700,
      textCase: "original",
      strokeColor: "#000000",
      strokePx: 2,
      shadow: true,
    },
    selectable: true,
  },
  {
    id: "bold-serif",
    name: "Bold Serif",
    style: {
      fontFamily: "Georgia, 'Times New Roman', serif",
      sizePx: 50,
      textColor: "#FFF8E7",
      highlightColor: "#F5B841",
      background: "none",
      position: "bottom",
      alignment: "center",
      weight: 700,
      textCase: "original",
      strokeColor: "#1A1A1A",
      strokePx: 3,
      shadow: true,
    },
    selectable: false,
  },
  {
    id: "karaoke",
    name: "Karaoke",
    style: {
      fontFamily: "Inter, system-ui, sans-serif",
      sizePx: 46,
      textColor: "#E5E5E5",
      highlightColor: "#FFD34D",
      background: "pill",
      position: "middle",
      alignment: "center",
      weight: 700,
      textCase: "uppercase",
      strokeColor: "#000000",
      strokePx: 0,
      shadow: false,
    },
    selectable: false,
  },
  {
    id: "quiet",
    name: "Quiet",
    style: {
      fontFamily: "Inter, system-ui, sans-serif",
      sizePx: 36,
      textColor: "#F5F5F4",
      highlightColor: "#F5F5F4",
      background: "none",
      position: "bottom",
      alignment: "center",
      weight: 500,
      textCase: "original",
      strokeColor: "#000000",
      strokePx: 1,
      shadow: false,
    },
    selectable: false,
  },
  {
    // Bottom Safe: sits in the bottom band every platform keeps clear of its own chrome, which is
    // what the safe-zone guides draw.
    id: "highlighter",
    name: "Highlighter",
    style: {
      fontFamily: "Inter, system-ui, sans-serif",
      sizePx: 48,
      textColor: "#FFFFFF",
      highlightColor: NEON_YELLOW,
      background: "none",
      position: "bottom",
      alignment: "center",
      weight: 800,
      textCase: "uppercase",
      strokeColor: "#000000",
      strokePx: 3,
      shadow: true,
    },
    selectable: true,
  },
];

/** What the picker offers. Everything else still resolves by id and still renders. */
export const SELECTABLE_CAPTION_PRESETS: CaptionPreset[] = CAPTION_PRESETS.filter(
  (preset) => preset.selectable,
);

export function getCaptionPreset(id: string): CaptionPreset {
  return CAPTION_PRESETS.find((preset) => preset.id === id) ?? CAPTION_PRESETS[0];
}
