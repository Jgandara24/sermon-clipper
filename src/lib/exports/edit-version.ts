import type { PrismaClient } from "@prisma/client";
import { buildDefaultEditorState, type EditorState } from "@/lib/editor/types";
import { ExportFailureError } from "./errors";

/**
 * P1.1: an export renders the edit version it was requested for, never "whatever is newest when
 * the worker gets around to it". The requested version is written to ExportJob.editVersion at
 * enqueue time and read back here — the two can never disagree, because both the stored version
 * and the idempotency key are derived from the same number by buildExportIdempotencyKey.
 */

/** No ClipEdit row exists for a clip that was never edited; its export renders the defaults. */
export const DEFAULT_EDIT_VERSION = 0;

// Defined beside the document it stamps, and re-exported here because this module is where the
// export layer reads versions from. One definition, no import cycle.
export { INITIAL_EDIT_VERSION } from "@/lib/editor/types";

/** The job carries no usable version, so there is nothing to render faithfully. */
export const EXPORT_EDIT_VERSION_MISSING = "EXPORT_EDIT_VERSION_MISSING";
/** The job names a version whose ClipEdit row is gone (deleted clip edits, restored backup). */
export const EXPORT_EDIT_VERSION_NOT_FOUND = "EXPORT_EDIT_VERSION_NOT_FOUND";
/** The row exists but its stored document is not an editor-state object. */
export const EXPORT_EDIT_VERSION_UNREADABLE = "EXPORT_EDIT_VERSION_UNREADABLE";

const MISSING_MESSAGE =
  "This export couldn't tell which saved version to render. Export the clip again from the editor.";
const NOT_FOUND_MESSAGE =
  "The saved version this export was requested for is no longer available. Export the clip again from the editor.";
const UNREADABLE_MESSAGE =
  "The saved version this export was requested for couldn't be read. Export the clip again from the editor.";

const KEY_PATTERN = /^export:([^:]+):v(\d+):([\s\S]*)$/;

/**
 * The single place an export idempotency key is built. Callers pass the version they intend to
 * pin, so the key's version and the row's editVersion are the same value by construction.
 */
export function buildExportIdempotencyKey(params: {
  clipId: string;
  editVersion: number;
  filename: string;
}): string {
  return `export:${params.clipId}:v${params.editVersion}:${params.filename}`;
}

/** Reads the version back out of a key. Returns null for keys written before P1.1. */
export function parseExportIdempotencyKeyVersion(key: string): number | null {
  const match = KEY_PATTERN.exec(key);
  return match ? Number.parseInt(match[2], 10) : null;
}

function isPinnableVersion(version: number | null): version is number {
  return version !== null && Number.isInteger(version) && version >= 0;
}

/**
 * Loads the exact editor state an export job was enqueued against.
 *
 * There is deliberately no newest-edit fallback: a job that cannot name its version, or whose
 * version no longer exists, fails closed rather than rendering a document the user never asked
 * for. Every failure here is terminal — re-running the same job cannot change the outcome.
 */
export async function loadPinnedEditorState(
  client: Pick<PrismaClient, "clipEdit">,
  params: {
    clipId: string;
    editVersion: number | null;
    defaults: { sourceVideoId: string; startMs: number; endMs: number };
  },
): Promise<EditorState> {
  if (!isPinnableVersion(params.editVersion)) {
    throw new ExportFailureError(EXPORT_EDIT_VERSION_MISSING, MISSING_MESSAGE, { terminal: true });
  }

  if (params.editVersion === DEFAULT_EDIT_VERSION) {
    return buildDefaultEditorState(params.defaults);
  }

  const edit = await client.clipEdit.findUnique({
    where: { clipId_version: { clipId: params.clipId, version: params.editVersion } },
  });
  if (!edit) {
    throw new ExportFailureError(EXPORT_EDIT_VERSION_NOT_FOUND, NOT_FOUND_MESSAGE, {
      terminal: true,
    });
  }
  if (typeof edit.editorState !== "object" || edit.editorState === null || Array.isArray(edit.editorState)) {
    throw new ExportFailureError(EXPORT_EDIT_VERSION_UNREADABLE, UNREADABLE_MESSAGE, {
      terminal: true,
    });
  }

  return edit.editorState as unknown as EditorState;
}
