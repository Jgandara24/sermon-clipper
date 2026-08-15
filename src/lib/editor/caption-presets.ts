import type { CaptionSafeAnchor } from "./social-safe-area";

export type CaptionStyle = {
  fontFamily: string;
  sizePx: number;
  textColor: string;
  highlightColor: string;
  background: "none" | "pill";
  /** @deprecated Legacy 3-way position; positionY/anchor are authoritative when present. */
  position: "top" | "middle" | "bottom";
  alignment: "left" | "center" | "right";
  uppercase: boolean;
  /** @deprecated Alias of outlineColor, kept because persisted presets/tests reference it. */
  strokeColor: string;
  /** @deprecated Alias of outlineWidthPx. */
  strokePx: number;
  /** @deprecated Alias of shadowDistancePx > 0. */
  shadow: boolean;
  // --- kinetic caption fields (normalizeCaptionStyle derives them for legacy presets) ---
  fontWeight: number; // 100..900
  highlightMode: "none" | "word";
  highlightScale: number; // 1.0 = no pop
  outlineColor: string;
  outlineWidthPx: number;
  shadowColor: string;
  shadowDistancePx: number; // 0 disables
  positionX: number; // 0..100, % of frame width
  positionY: number; // 0..100, % of frame height
  anchor: "center" | "bottom"; // how positionY anchors the caption block
  safeAnchor: CaptionSafeAnchor;
  maxWordsPerLine: number;
};

/** The style fields a preset literal must define; everything else is derived. */
type CaptionStyleBase = Omit<
  CaptionStyle,
  | "fontWeight"
  | "highlightMode"
  | "highlightScale"
  | "outlineColor"
  | "outlineWidthPx"
  | "shadowColor"
  | "shadowDistancePx"
  | "positionX"
  | "positionY"
  | "anchor"
  | "safeAnchor"
  | "maxWordsPerLine"
> &
  Partial<CaptionStyle>;

export type CaptionPreset = {
  id: string;
  name: string;
  style: CaptionStyle;
};

/**
 * Slider bounds shared by the zod override schema AND the UI controls, so validation and the
 * panel can never drift apart.
 */
export const CAPTION_STYLE_LIMITS = {
  sizePx: { min: 16, max: 160, step: 1 },
  fontWeight: { min: 100, max: 900, step: 100 },
  highlightScale: { min: 1, max: 1.4, step: 0.01 },
  outlineWidthPx: { min: 0, max: 24, step: 1 },
  shadowDistancePx: { min: 0, max: 24, step: 1 },
  positionX: { min: 0, max: 100, step: 0.5 },
  positionY: { min: 0, max: 100, step: 0.5 },
  maxWordsPerLine: { min: 2, max: 8, step: 1 },
} as const;

export function clampToLimit(
  value: number,
  limit: { min: number; max: number },
): number {
  return Math.min(limit.max, Math.max(limit.min, value));
}

/**
 * Fills every kinetic field from a preset's base fields. The legacy position→positionY
 * mapping reproduces the old ASS margins exactly: top=8% (marginV 8%), middle=50 centered,
 * bottom=88 bottom-anchored (marginV 12%).
 */
export function normalizeCaptionStyle(base: CaptionStyleBase): CaptionStyle {
  const positionY =
    base.positionY ?? (base.position === "top" ? 8 : base.position === "middle" ? 50 : 88);
  const anchor = base.anchor ?? (base.position === "bottom" ? "bottom" : "center");
  return {
    ...base,
    fontWeight: base.fontWeight ?? 400,
    highlightMode: base.highlightMode ?? "none",
    highlightScale: base.highlightScale ?? 1,
    outlineColor: base.outlineColor ?? base.strokeColor,
    outlineWidthPx: base.outlineWidthPx ?? base.strokePx,
    shadowColor: base.shadowColor ?? "#000000",
    shadowDistancePx: base.shadowDistancePx ?? (base.shadow ? 2 : 0),
    positionX: base.positionX ?? 50,
    positionY,
    anchor,
    safeAnchor: base.safeAnchor ?? "custom",
    maxWordsPerLine: base.maxWordsPerLine ?? 5,
  };
}

// Original names/styles per guide §13 — never reuse a competitor's preset names.
// Legacy presets keep highlightMode "none": existing clips must not suddenly animate.
export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: "clean",
    name: "Clean",
    style: normalizeCaptionStyle({
      fontFamily: "Poppins, system-ui, sans-serif",
      sizePx: 44,
      textColor: "#FFFFFF",
      highlightColor: "#2DD4BF",
      background: "none",
      position: "bottom",
      alignment: "center",
      uppercase: false,
      strokeColor: "#000000",
      strokePx: 2,
      shadow: true,
    }),
  },
  {
    id: "bold-serif",
    name: "Bold Serif",
    style: normalizeCaptionStyle({
      // Libre serif (shipped in public/fonts) — Georgia is Microsoft-licensed and can't ship
      // in the worker image, and burning a font we don't have never rendered as intended.
      fontFamily: "'Source Serif 4', Georgia, serif",
      sizePx: 50,
      textColor: "#FFF8E7",
      highlightColor: "#F5B841",
      background: "none",
      position: "bottom",
      alignment: "center",
      uppercase: false,
      strokeColor: "#1A1A1A",
      strokePx: 3,
      shadow: true,
      fontWeight: 600,
    }),
  },
  {
    id: "karaoke",
    name: "Karaoke",
    style: normalizeCaptionStyle({
      fontFamily: "Poppins, system-ui, sans-serif",
      sizePx: 46,
      textColor: "#E5E5E5",
      highlightColor: "#FFD34D",
      background: "pill",
      position: "middle",
      alignment: "center",
      uppercase: true,
      strokeColor: "#000000",
      strokePx: 0,
      shadow: false,
      // Finally what the name claims: per-word highlight (DECISIONS.md karaoke deferral).
      highlightMode: "word",
      highlightScale: 1.08,
      fontWeight: 700,
    }),
  },
  {
    id: "quiet",
    name: "Quiet",
    style: normalizeCaptionStyle({
      fontFamily: "Poppins, system-ui, sans-serif",
      sizePx: 36,
      textColor: "#F5F5F4",
      highlightColor: "#F5F5F4",
      background: "none",
      position: "bottom",
      alignment: "center",
      uppercase: false,
      strokeColor: "#000000",
      strokePx: 1,
      shadow: false,
    }),
  },
  {
    id: "kinetic",
    name: "Kinetic",
    style: normalizeCaptionStyle({
      fontFamily: "Poppins, system-ui, sans-serif",
      sizePx: 52,
      textColor: "#FFFFFF",
      highlightColor: "#FFD34D",
      background: "none",
      position: "middle",
      alignment: "center",
      uppercase: true,
      strokeColor: "#000000",
      strokePx: 6,
      shadow: false,
      highlightMode: "word",
      highlightScale: 1.14,
      fontWeight: 800,
      outlineWidthPx: 6,
      positionY: 62,
      anchor: "center",
      maxWordsPerLine: 4,
    }),
  },
];

export function getCaptionPreset(id: string): CaptionPreset {
  return CAPTION_PRESETS.find((preset) => preset.id === id) ?? CAPTION_PRESETS[0];
}
