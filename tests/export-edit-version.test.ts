import { describe, expect, it, vi } from "vitest";
import { buildDefaultEditorState } from "@/lib/editor/types";
import {
  buildExportIdempotencyKey,
  EXPORT_EDIT_VERSION_MISSING,
  EXPORT_EDIT_VERSION_NOT_FOUND,
  EXPORT_EDIT_VERSION_UNREADABLE,
  loadPinnedEditorState,
  parseExportIdempotencyKeyVersion,
} from "@/lib/exports/edit-version";
import { ExportFailureError } from "@/lib/exports/errors";

const DEFAULTS = { sourceVideoId: "video-1", startMs: 0, endMs: 4000 };

function editorStateForVersion(version: number) {
  return { ...buildDefaultEditorState(DEFAULTS), version };
}

/**
 * A client whose only edit-reading paths are instrumented. `findFirst` is the newest-edit
 * fallback P1.1 removes: any call to it is a defect, so the stub fails loudly.
 */
function clientWithEdits(edits: Array<{ version: number }>) {
  const findUnique = vi.fn(async ({ where }: { where: { clipId_version: { clipId: string; version: number } } }) => {
    const match = edits.find((edit) => edit.version === where.clipId_version.version);
    return match ? { ...match, clipId: where.clipId_version.clipId, editorState: editorStateForVersion(match.version) } : null;
  });
  const findFirst = vi.fn(async () => {
    throw new Error("loadPinnedEditorState must never select an edit by ordering");
  });
  return { client: { clipEdit: { findUnique, findFirst } }, findUnique, findFirst };
}

describe("buildExportIdempotencyKey", () => {
  it("encodes the clip, the edit version, and the filename", () => {
    expect(
      buildExportIdempotencyKey({ clipId: "clip-1", editVersion: 7, filename: "sermon.mp4" }),
    ).toBe("export:clip-1:v7:sermon.mp4");
  });

  it("round-trips the version back out, even for a filename containing colons", () => {
    const key = buildExportIdempotencyKey({
      clipId: "clip-1",
      editVersion: 12,
      filename: "series: part 2 - v3.mp4",
    });
    expect(parseExportIdempotencyKeyVersion(key)).toBe(12);
  });

  it("reads version 0 back as 0, not as a missing version", () => {
    const key = buildExportIdempotencyKey({ clipId: "clip-1", editVersion: 0, filename: "a.mp4" });
    expect(parseExportIdempotencyKeyVersion(key)).toBe(0);
  });

  it("returns null for a key that carries no version", () => {
    expect(parseExportIdempotencyKeyVersion("export:clip-1:sermon.mp4")).toBeNull();
  });
});

describe("loadPinnedEditorState", () => {
  it("returns the exact stored version, not the newest one", async () => {
    const { client, findUnique, findFirst } = clientWithEdits([{ version: 1 }, { version: 2 }]);

    const state = await loadPinnedEditorState(client as never, {
      clipId: "clip-1",
      editVersion: 1,
      defaults: DEFAULTS,
    });

    expect(state.version).toBe(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { clipId_version: { clipId: "clip-1", version: 1 } },
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("uses the default editor state for version 0 without reading any edit", async () => {
    const { client, findUnique, findFirst } = clientWithEdits([{ version: 4 }]);

    const state = await loadPinnedEditorState(client as never, {
      clipId: "clip-1",
      editVersion: 0,
      defaults: DEFAULTS,
    });

    expect(state).toEqual(buildDefaultEditorState(DEFAULTS));
    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("fails closed with a stable code when the job carries no version", async () => {
    const { client, findUnique, findFirst } = clientWithEdits([{ version: 1 }]);

    const error = await loadPinnedEditorState(client as never, {
      clipId: "clip-1",
      editVersion: null,
      defaults: DEFAULTS,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ExportFailureError);
    expect((error as ExportFailureError).code).toBe(EXPORT_EDIT_VERSION_MISSING);
    expect((error as ExportFailureError).terminal).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("fails closed with a stable code when the exact version no longer exists", async () => {
    const { client, findFirst } = clientWithEdits([{ version: 1 }, { version: 2 }]);

    const error = await loadPinnedEditorState(client as never, {
      clipId: "clip-1",
      editVersion: 3,
      defaults: DEFAULTS,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ExportFailureError);
    expect((error as ExportFailureError).code).toBe(EXPORT_EDIT_VERSION_NOT_FOUND);
    expect((error as ExportFailureError).terminal).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("fails closed rather than rendering anything for a nonsensical version", async () => {
    const { client } = clientWithEdits([{ version: 1 }]);

    for (const editVersion of [-1, 1.5, Number.NaN]) {
      const error = await loadPinnedEditorState(client as never, {
        clipId: "clip-1",
        editVersion,
        defaults: DEFAULTS,
      }).catch((thrown: unknown) => thrown);

      expect((error as ExportFailureError).code).toBe(EXPORT_EDIT_VERSION_MISSING);
      expect((error as ExportFailureError).terminal).toBe(true);
    }
  });

  it("fails closed rather than rendering defaults when the stored document is not an object", async () => {
    const client = {
      clipEdit: {
        findUnique: vi.fn(async () => ({ version: 2, editorState: null })),
        findFirst: vi.fn(),
      },
    };

    const error = await loadPinnedEditorState(client as never, {
      clipId: "clip-1",
      editVersion: 2,
      defaults: DEFAULTS,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ExportFailureError);
    expect((error as ExportFailureError).code).toBe(EXPORT_EDIT_VERSION_UNREADABLE);
    expect((error as ExportFailureError).terminal).toBe(true);
  });
});
