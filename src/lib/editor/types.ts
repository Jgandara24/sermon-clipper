import { z } from "zod";
import { DEFAULT_TEXT_CASE, TEXT_CASES } from "./text-case";

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
    // Corrections to what a word says, keyed by the same stable word id everything else uses. A
    // correction changes the text and nothing else — never the word's id, never its timestamps,
    // and never the clip's range. Defaulted so documents written before Slice 5 still parse.
    textOverrides: z
      .array(z.object({ wordId: z.string(), text: z.string() }))
      .default([]),
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
      textCase: z.enum(TEXT_CASES).optional(),
      // Where the caption sits on the canvas, as fractions of the frame, once the member has
      // dragged it. Absent means "wherever `position` puts it" — which is every clip made before
      // direct manipulation existed, and they must keep rendering exactly where they always did.
      box: z
        .object({ xPct: z.number().min(0).max(1), yPct: z.number().min(0).max(1) })
        .optional(),
      // Legacy: documents written before the shared case model carry only this. Still parsed so
      // those clips keep rendering what they always rendered.
      uppercase: z.boolean().optional(),
      highlightColor: z.string().optional(),
      fontFamily: z.string().min(1).max(200).optional(),
      weight: z.number().int().min(100).max(900).optional(),
      strokePx: z.number().min(0).max(20).optional(),
      shadow: z.boolean().optional(),
      background: z.enum(["none", "pill"]).optional(),
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
    wordEdits: { deletedWordIds: [], restoredFillerIds: [], textOverrides: [] },
    extensions: [],
    // Uppercase is the default for new content only. A stored document that carries no case
    // keeps falling back to its preset's, so nothing already made changes appearance.
    captions: {
      presetId: "clean",
      overrides: { textCase: DEFAULT_TEXT_CASE },
      textOverrides: [],
    },
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
