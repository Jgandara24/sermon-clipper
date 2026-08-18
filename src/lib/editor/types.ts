import { z } from "zod";
import { CAPTION_STYLE_LIMITS } from "./caption-presets";

// Editor state is one versioned JSON document per clip (guide §12). `version` is duplicated
// inside the document (matching the guide's own example) for client convenience, but
// ClipEdit.version in the database is authoritative for optimistic concurrency.
export const editorStateSchema = z.object({
  version: z.number().int().min(0),
  source: z.object({
    videoId: z.string(),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
  }),
  wordEdits: z.object({
    deletedWordIds: z.array(z.string()),
    restoredFillerIds: z.array(z.string()),
  }),
  extensions: z.array(
    z.object({
      startMs: z.number().int(),
      endMs: z.number().int(),
      position: z.enum(["before", "after"]),
    }),
  ),
  captions: z.object({
    presetId: z.string(),
    // Every key optional: persisted documents from any prior schema version must keep
    // parsing. Numeric bounds come from CAPTION_STYLE_LIMITS so the UI sliders and this
    // validation can never drift. Color strings are intentionally NOT rejected on format —
    // legacy rows may hold loose values; resolveCaptionStyle coerces bad colors instead,
    // because a save failure on an old clip is worse than a color fallback.
    overrides: z.object({
      sizePx: z
        .number()
        .int()
        .min(CAPTION_STYLE_LIMITS.sizePx.min)
        .max(CAPTION_STYLE_LIMITS.sizePx.max)
        .optional(),
      position: z.enum(["top", "middle", "bottom"]).optional(),
      uppercase: z.boolean().optional(),
      highlightColor: z.string().optional(),
      fontFamily: z.string().max(120).optional(),
      fontWeight: z
        .number()
        .int()
        .min(CAPTION_STYLE_LIMITS.fontWeight.min)
        .max(CAPTION_STYLE_LIMITS.fontWeight.max)
        .optional(),
      textColor: z.string().optional(),
      highlightMode: z.enum(["none", "word"]).optional(),
      highlightScale: z
        .number()
        .min(CAPTION_STYLE_LIMITS.highlightScale.min)
        .max(CAPTION_STYLE_LIMITS.highlightScale.max)
        .optional(),
      outlineColor: z.string().optional(),
      outlineWidthPx: z
        .number()
        .min(CAPTION_STYLE_LIMITS.outlineWidthPx.min)
        .max(CAPTION_STYLE_LIMITS.outlineWidthPx.max)
        .optional(),
      shadowColor: z.string().optional(),
      shadowDistancePx: z
        .number()
        .min(CAPTION_STYLE_LIMITS.shadowDistancePx.min)
        .max(CAPTION_STYLE_LIMITS.shadowDistancePx.max)
        .optional(),
      positionX: z
        .number()
        .min(CAPTION_STYLE_LIMITS.positionX.min)
        .max(CAPTION_STYLE_LIMITS.positionX.max)
        .optional(),
      positionY: z
        .number()
        .min(CAPTION_STYLE_LIMITS.positionY.min)
        .max(CAPTION_STYLE_LIMITS.positionY.max)
        .optional(),
      anchor: z.enum(["center", "bottom"]).optional(),
      safeAnchor: z.enum(["top-safe", "center", "bottom-safe", "custom"]).optional(),
    }),
    textOverrides: z.array(z.object({ segmentId: z.string(), text: z.string() })),
    wordTextOverrides: z
      .array(z.object({ wordId: z.string(), text: z.string().max(120) }))
      .optional(),
  }),
  layout: z.object({
    mode: z.enum(["center", "face", "manual"]),
    crop: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().min(0).max(1),
      h: z.number().min(0).max(1),
    }),
    aspect: z.literal("9:16"),
  }),
  overlays: z.array(z.unknown()),
  brandTemplateId: z.string().nullable(),
  audio: z.object({ originalVolume: z.number().min(0).max(2) }),
  export: z.object({ preset: z.literal("mp4_1080") }),
});

export type EditorState = z.infer<typeof editorStateSchema>;

export function buildDefaultEditorState(params: {
  sourceVideoId: string;
  startMs: number;
  endMs: number;
}): EditorState {
  return {
    version: 0,
    source: { videoId: params.sourceVideoId, startMs: params.startMs, endMs: params.endMs },
    wordEdits: { deletedWordIds: [], restoredFillerIds: [] },
    extensions: [],
    captions: { presetId: "clean", overrides: {}, textOverrides: [], wordTextOverrides: [] },
    layout: { mode: "center", crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: "9:16" },
    overlays: [],
    brandTemplateId: null,
    audio: { originalVolume: 1 },
    export: { preset: "mp4_1080" },
  };
}

/** Stable per-word id for editor references — words have no DB row of their own. */
export function wordId(segmentId: string, wordIndex: number): string {
  return `${segmentId}:${wordIndex}`;
}

/**
 * A word is deleted only through an explicit word-id edit. `isFiller` and restored filler ids stay
 * readable as legacy metadata, but neither changes delivery behavior.
 */
export function isWordDeleted(state: EditorState, id: string): boolean {
  return state.wordEdits.deletedWordIds.includes(id);
}
