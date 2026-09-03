import { z } from "zod";
import { DEFAULT_TEXT_CASE, TEXT_CASES } from "@/lib/editor/text-case";

/**
 * The title overlay's model.
 *
 * `EditorState.overlays` has been `z.array(z.unknown())` since the beginning, and every stored
 * document carries whatever was in it. A stricter parser that rejected an old shape would stop
 * clips loading, so the rule here is **parse leniently, write strictly**: reading finds the one
 * entry that is a title and steps over everything else untouched, and writing validates before it
 * puts anything in.
 *
 * Nothing in this file knows where a title is drawn. The anchor names a place in the shared safe
 * area, and both renderers resolve it there, so the title starts life with no private copy of the
 * frame's geometry.
 */

/** How long a title lasts before anyone changes it. */
export const TITLE_BANNER_DEFAULT_DURATION_MS = 3000;

/** The face is a bundled one. Nothing else is available to the worker to draw with. */
export const TITLE_BANNER_FONT_FAMILY = "DejaVu Sans";

const hexColour = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "a colour is six hex digits behind a hash");

export const titleBannerSchema = z.object({
  type: z.literal("title"),
  id: z.string().min(1),
  text: z.string().max(200),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  /** Where it is pinned in the shared safe area. `custom` means `box` carries the point. */
  anchor: z.enum(["top-safe", "center", "bottom-safe", "custom"]),
  /** The banner's centre, as fractions of the frame, once it has been dragged. */
  box: z.object({ xPct: z.number().min(0).max(1), yPct: z.number().min(0).max(1) }).optional(),
  /** How wide the banner is, as a fraction of the frame. Corner-resize writes this. */
  widthPct: z.number().min(0.1).max(1),
  align: z.enum(["left", "center", "right"]),
  textCase: z.enum(TEXT_CASES),
  fontFamily: z.string().min(1).max(200),
  sizePx: z.number().int().min(16).max(200),
  weight: z.number().int().min(100).max(900),
  color: hexColour,
  backgroundColor: hexColour,
  border: z.object({ widthPx: z.number().min(0).max(20), color: hexColour }),
  shadow: z.boolean(),
});

export type TitleBanner = z.infer<typeof titleBannerSchema>;

/** The marker a dismissal leaves behind, so an automatic default does not undo the member's X. */
const DISMISSED_MARKER = { type: "titleDismissed" } as const;

function isTitleEntry(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "title";
}

function isDismissalEntry(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as { type?: unknown }).type === DISMISSED_MARKER.type
  );
}

/**
 * The title in these overlays, or null.
 *
 * An entry that says it is a title but does not parse is treated as no title. A document written by
 * a later version, or a corrupted one, must not stop a clip loading.
 */
export function readTitleBanner(overlays: readonly unknown[]): TitleBanner | null {
  for (const entry of overlays) {
    if (!isTitleEntry(entry)) continue;
    const parsed = titleBannerSchema.safeParse(entry);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** The default title for a clip: its first three seconds, top safe, uppercase black on white. */
export function defaultTitleBanner(clip: { startMs: number; endMs: number }): TitleBanner {
  return {
    type: "title",
    id: "title",
    text: "",
    startMs: clip.startMs,
    // A clip shorter than the default gets a title that ends with it rather than one that runs off
    // the end and is never fully seen.
    endMs: Math.min(clip.endMs, clip.startMs + TITLE_BANNER_DEFAULT_DURATION_MS),
    anchor: "top-safe",
    widthPct: 0.88,
    align: "center",
    textCase: DEFAULT_TEXT_CASE,
    fontFamily: TITLE_BANNER_FONT_FAMILY,
    sizePx: 64,
    weight: 700,
    color: "#000000",
    backgroundColor: "#FFFFFF",
    border: { widthPx: 0, color: "#000000" },
    shadow: false,
  };
}

/**
 * Writes a title into overlays, replacing any title already there.
 *
 * Validated first: nothing invalid reaches a stored document, however lenient reading is. Writing
 * also clears a dismissal, because putting a title back is the member asking for one.
 */
export function upsertTitleBanner(
  overlays: readonly unknown[],
  title: TitleBanner,
): unknown[] {
  const valid = titleBannerSchema.parse(title);
  const others = overlays.filter((entry) => !isTitleEntry(entry) && !isDismissalEntry(entry));
  return [...others, valid];
}

/** Drops the title, leaving everything else — including any dismissal — as it was. */
export function removeTitleBanner(overlays: readonly unknown[]): unknown[] {
  return overlays.filter((entry) => !isTitleEntry(entry));
}

/**
 * Drops the title and records that the member does not want one.
 *
 * This is what the X does. Without the marker, anything that ensures a default would put the title
 * straight back on the next load, and the member would have to remove it every time.
 */
export function dismissTitleBanner(overlays: readonly unknown[]): unknown[] {
  return [...removeTitleBanner(overlays).filter((entry) => !isDismissalEntry(entry)), DISMISSED_MARKER];
}

/** Whether a title was dismissed rather than simply absent. */
export function isTitleDismissed(overlays: readonly unknown[]): boolean {
  return overlays.some(isDismissalEntry);
}

/** The shortest a title may be trimmed to. Below this it cannot be grabbed again. */
export const TITLE_BANNER_MIN_DURATION_MS = 200;

export type TitleRange = { startMs: number; endMs: number };

/**
 * Moves the whole title by an offset, keeping its length.
 *
 * It stops at the clip's edges rather than being shortened by them: a title dragged past the end
 * that lost its length on the way would come back a different length, which is not what dragging
 * something means.
 */
export function moveTitleRange(
  range: TitleRange,
  deltaMs: number,
  clip: TitleRange,
): TitleRange {
  const length = range.endMs - range.startMs;
  const room = Math.max(clip.startMs, clip.endMs - length);
  const startMs = Math.round(Math.min(room, Math.max(clip.startMs, range.startMs + deltaMs)));
  return { startMs, endMs: startMs + length };
}

/**
 * Trims one end of the title.
 *
 * The other end does not move, and the two cannot cross: an edge dragged past its opposite stops a
 * minimum duration short of it.
 */
export function trimTitleRange(
  range: TitleRange,
  edge: "start" | "end",
  ms: number,
  clip: TitleRange,
): TitleRange {
  const inClip = Math.min(clip.endMs, Math.max(clip.startMs, Math.round(ms)));
  if (edge === "start") {
    return { ...range, startMs: Math.min(inClip, range.endMs - TITLE_BANNER_MIN_DURATION_MS) };
  }
  return { ...range, endMs: Math.max(inClip, range.startMs + TITLE_BANNER_MIN_DURATION_MS) };
}

/**
 * Moves a title onto another timeline.
 *
 * Every time in an editor document is on the source's timeline. The rendered file plays the kept
 * ranges concatenated, so a title left on the source timeline drifts by however much was deleted
 * before it — the same remap the caption lines already go through, named rather than repeated.
 */
export function retimeTitleBanner(
  title: TitleBanner,
  mapMs: (ms: number) => number,
): TitleBanner {
  return { ...title, startMs: mapMs(title.startMs), endMs: mapMs(title.endMs) };
}

/**
 * Adds the default title when there is none and none was dismissed.
 *
 * Leaves an existing title exactly as it is — including one whose every setting has been changed.
 */
export function ensureDefaultTitleBanner(
  overlays: readonly unknown[],
  clip: { startMs: number; endMs: number },
): unknown[] {
  if (readTitleBanner(overlays) !== null) return [...overlays];
  if (isTitleDismissed(overlays)) return [...overlays];
  return upsertTitleBanner(overlays, defaultTitleBanner(clip));
}
