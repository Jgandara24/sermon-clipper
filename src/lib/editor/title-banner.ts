export type TitleBannerOverlay = {
  type: "titleBanner";
  id: "title-banner";
  text: string;
  startMs: number;
  endMs: number;
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  textColor: string;
  backgroundColor: string;
  borderRadiusPx: number;
  borderWidthPx: number;
  borderColor: string;
  shadowDistancePx: number;
  shadowColor: string;
  widthPct: number;
  positionX: number;
  positionY: number;
  alignment: "left" | "center" | "right";
  italic: boolean;
  underline: boolean;
};

export const TITLE_BANNER_DEFAULTS = {
  fontFamily: "poppins",
  fontSizePx: 40,
  fontWeight: 700,
  textColor: "#000000",
  backgroundColor: "#FFFFFF",
  borderRadiusPx: 10,
  borderWidthPx: 0,
  borderColor: "#000000",
  shadowDistancePx: 0,
  shadowColor: "#000000",
  widthPct: 75,
  positionX: 50,
  positionY: 12,
  alignment: "center" as const,
  italic: false,
  underline: false,
};

const TITLE_BANNER_DISMISSED_TYPE = "titleBannerDismissed";

function isTitleBannerDismissed(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).type === TITLE_BANNER_DISMISSED_TYPE,
  );
}

function isTitleBanner(value: unknown): value is TitleBannerOverlay {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "titleBanner" &&
    candidate.id === "title-banner" &&
    typeof candidate.text === "string" &&
    Number.isFinite(candidate.startMs) &&
    Number.isFinite(candidate.endMs)
  );
}

function normalizeTitleBanner(value: TitleBannerOverlay): TitleBannerOverlay {
  const legacy = value as TitleBannerOverlay & Partial<typeof TITLE_BANNER_DEFAULTS>;
  const widthPct = Math.min(100, Math.max(30, Number(legacy.widthPct ?? 75)));
  const halfWidthPct = widthPct / 2;
  return {
    ...TITLE_BANNER_DEFAULTS,
    ...legacy,
    fontSizePx: Math.min(120, Math.max(16, Number(legacy.fontSizePx ?? 40))),
    fontWeight: [400, 600, 700, 800].includes(Number(legacy.fontWeight))
      ? Number(legacy.fontWeight)
      : 700,
    borderRadiusPx: Math.min(40, Math.max(0, Number(legacy.borderRadiusPx ?? 10))),
    borderWidthPx: Math.min(20, Math.max(0, Number(legacy.borderWidthPx ?? 0))),
    borderColor:
      typeof legacy.borderColor === "string" ? legacy.borderColor : TITLE_BANNER_DEFAULTS.borderColor,
    shadowDistancePx: Math.min(30, Math.max(0, Number(legacy.shadowDistancePx ?? 0))),
    shadowColor:
      typeof legacy.shadowColor === "string" ? legacy.shadowColor : TITLE_BANNER_DEFAULTS.shadowColor,
    widthPct,
    positionX: Math.min(
      100 - halfWidthPct,
      Math.max(halfWidthPct, Number(legacy.positionX ?? 50)),
    ),
    positionY: Math.min(95, Math.max(5, Number(legacy.positionY ?? 12))),
    alignment: ["left", "center", "right"].includes(String(legacy.alignment))
      ? legacy.alignment
      : "center",
  };
}

export function createTitleBanner(params: {
  text: string;
  startMs: number;
  endMs: number;
}): TitleBannerOverlay {
  return {
    type: "titleBanner",
    id: "title-banner",
    ...TITLE_BANNER_DEFAULTS,
    text: params.text.trim().slice(0, 120),
    startMs: Math.max(0, Math.round(params.startMs)),
    endMs: Math.max(0, Math.round(params.endMs)),
  };
}

export function readTitleBanner(overlays: readonly unknown[]): TitleBannerOverlay | null {
  const banner = overlays.find(isTitleBanner);
  return banner ? normalizeTitleBanner(banner) : null;
}

export function upsertTitleBanner(
  overlays: readonly unknown[],
  banner: TitleBannerOverlay,
): unknown[] {
  return [
    ...overlays.filter((overlay) => !isTitleBanner(overlay) && !isTitleBannerDismissed(overlay)),
    banner,
  ];
}

export function removeTitleBanner(overlays: readonly unknown[]): unknown[] {
  return overlays.filter((overlay) => !isTitleBanner(overlay));
}

export function dismissTitleBanner(overlays: readonly unknown[]): unknown[] {
  return [
    ...overlays.filter((overlay) => !isTitleBanner(overlay) && !isTitleBannerDismissed(overlay)),
    { type: TITLE_BANNER_DISMISSED_TYPE },
  ];
}

export function ensureDefaultTitleBanner(
  overlays: readonly unknown[],
  params: { text: string; clipStartMs: number; clipEndMs: number },
): unknown[] {
  if (overlays.some(isTitleBannerDismissed)) return [...overlays];

  const defaultEndMs = Math.min(params.clipEndMs, params.clipStartMs + 3_000);
  const current = readTitleBanner(overlays);
  if (current) {
    const hasOldFullClipDefault =
      current.startMs === params.clipStartMs &&
      current.endMs === params.clipEndMs &&
      params.clipEndMs - params.clipStartMs > 3_000;
    return hasOldFullClipDefault
      ? upsertTitleBanner(overlays, { ...current, endMs: defaultEndMs })
      : [...overlays];
  }

  return upsertTitleBanner(
    overlays,
    createTitleBanner({
      text: params.text,
      startMs: params.clipStartMs,
      endMs: defaultEndMs,
    }),
  );
}
