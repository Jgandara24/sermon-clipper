import { describe, expect, it } from "vitest";
import {
  createDocumentHistory,
  updateDocumentHistory,
} from "@/lib/editor/document-history";

describe("document history", () => {
  it("undoes one completed edit and makes it redoable", () => {
    const initial = createDocumentHistory({ title: "First" });
    const edited = updateDocumentHistory(initial, {
      type: "edit",
      document: { title: "Second" },
    });
    const undone = updateDocumentHistory(edited, { type: "undo" });

    expect(undone).toEqual({
      past: [],
      present: { title: "First" },
      future: [{ title: "Second" }],
      activeGroup: null,
    });
  });

  it("reapplies an undone edit", () => {
    const initial = createDocumentHistory({ title: "First" });
    const edited = updateDocumentHistory(initial, {
      type: "edit",
      document: { title: "Second" },
    });
    const undone = updateDocumentHistory(edited, { type: "undo" });
    const redone = updateDocumentHistory(undone, { type: "redo" });

    expect(redone.present).toEqual({ title: "Second" });
    expect(redone.past).toEqual([{ title: "First" }]);
    expect(redone.future).toEqual([]);
  });

  it("treats repeated updates in one active group as one undo step", () => {
    const initial = createDocumentHistory({ size: 10 });
    const firstMove = updateDocumentHistory(initial, {
      type: "edit",
      document: { size: 11 },
      group: "size-drag",
    });
    const secondMove = updateDocumentHistory(firstMove, {
      type: "edit",
      document: { size: 12 },
      group: "size-drag",
    });
    const finished = updateDocumentHistory(secondMove, {
      type: "end-group",
      group: "size-drag",
    });
    const undone = updateDocumentHistory(finished, { type: "undo" });

    expect(undone.present).toEqual({ size: 10 });
    expect(undone.future).toEqual([{ size: 12 }]);
  });

  it("syncs server bookkeeping without adding an undo step", () => {
    const initial = createDocumentHistory({ title: "First", version: 1 });
    const edited = updateDocumentHistory(initial, {
      type: "edit",
      document: { title: "Second", version: 1 },
    });
    const synced = updateDocumentHistory(edited, {
      type: "sync",
      document: { title: "Second", version: 2 },
    });
    const undone = updateDocumentHistory(synced, { type: "undo" });

    expect(synced.present).toEqual({ title: "Second", version: 2 });
    expect(undone.present).toEqual({ title: "First", version: 1 });
  });
});
