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
  it("identifies an export by clip and edit version alone", () => {
    expect(buildExportIdempotencyKey({ clipId: "clip-1", editVersion: 7 })).toBe("export:clip-1:v7");
  });

  it("reads version 0 back as 0, not as a missing version", () => {
    const key = buildExportIdempotencyKey({ clipId: "clip-1", editVersion: 0 });
    expect(key).toBe("export:clip-1:v0");
    expect(parseExportIdempotencyKeyVersion(key)).toBe(0);
  });

  it("round-trips every version it writes", () => {
    for (const editVersion of [0, 1, 9, 137]) {
      const key = buildExportIdempotencyKey({ clipId: "clip-1", editVersion });
      expect(parseExportIdempotencyKeyVersion(key)).toBe(editVersion);
    }
  });
});

describe("parseExportIdempotencyKeyVersion reads keys written before P1.2", () => {
  // P1.2 removed the filename from the identity. Rows written before it still carry the old
  // three-part key, and their version must stay readable — a key that stops parsing turns a
  // pinned legacy export into an unpinned one, which is exactly what P1.1 forbids.
  it("reads the version out of a legacy key that carries a filename", () => {
    expect(parseExportIdempotencyKeyVersion("export:clip-1:v7:sermon.mp4")).toBe(7);
  });

  it("reads the version out of a legacy key whose filename contains colons", () => {
    expect(parseExportIdempotencyKeyVersion("export:clip-1:v12:series: part 2 - v3.mp4")).toBe(12);
  });

  it("reads legacy version 0 back as 0", () => {
    expect(parseExportIdempotencyKeyVersion("export:clip-1:v0:a.mp4")).toBe(0);
  });

  it("returns null for a key that carries no version at all", () => {
    expect(parseExportIdempotencyKeyVersion("export:clip-1:sermon.mp4")).toBeNull();
  });

  it("returns null for a key from another queue", () => {
    expect(parseExportIdempotencyKeyVersion("probe:project-1")).toBeNull();
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
