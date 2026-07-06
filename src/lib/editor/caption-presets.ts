export type CaptionStyle = {
  fontFamily: string;
  sizePx: number;
  textColor: string;
  highlightColor: string;
  background: "none" | "pill";
  position: "top" | "middle" | "bottom";
  alignment: "left" | "center" | "right";
  uppercase: boolean;
  strokeColor: string;
  strokePx: number;
  shadow: boolean;
};

export type CaptionPreset = {
  id: string;
  name: string;
  style: CaptionStyle;
};

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
      uppercase: false,
      strokeColor: "#000000",
      strokePx: 2,
      shadow: true,
    },
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
      uppercase: false,
      strokeColor: "#1A1A1A",
      strokePx: 3,
      shadow: true,
    },
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
      uppercase: true,
      strokeColor: "#000000",
      strokePx: 0,
      shadow: false,
    },
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
      uppercase: false,
      strokeColor: "#000000",
      strokePx: 1,
      shadow: false,
    },
  },
];

export function getCaptionPreset(id: string): CaptionPreset {
  return CAPTION_PRESETS.find((preset) => preset.id === id) ?? CAPTION_PRESETS[0];
}
