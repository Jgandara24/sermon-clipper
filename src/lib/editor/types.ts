import { z } from "zod";

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
    overrides: z.object({
      sizePx: z.number().int().min(16).max(160).optional(),
      position: z.enum(["top", "middle", "bottom"]).optional(),
      uppercase: z.boolean().optional(),
      highlightColor: z.string().optional(),
    }),
    textOverrides: z.array(z.object({ segmentId: z.string(), text: z.string() })),
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
    captions: { presetId: "clean", overrides: {}, textOverrides: [] },
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
 * A word is effectively deleted if it's flagged filler and not explicitly restored, or if it's
 * been explicitly deleted — fillers are excluded from the cut by default (guide §12/§13).
 */
export function isWordDeleted(state: EditorState, id: string, isFiller: boolean): boolean {
  if (isFiller) {
    return !state.wordEdits.restoredFillerIds.includes(id);
  }
  return state.wordEdits.deletedWordIds.includes(id);
}
