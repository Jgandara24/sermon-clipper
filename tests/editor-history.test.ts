import { describe, expect, it } from "vitest";
import {
  applyConfirmedSave,
  canRedo,
  canUndo,
  closeInteraction,
  createHistory,
  type EditorHistory,
  historyShortcut,
  isTextEntryTarget,
  recordEdit,
  redo,
  undo,
} from "@/lib/editor/history";

type Doc = { value: string; version?: number };

const start: Doc = { value: "start" };

function edits(history: EditorHistory<Doc>, ...values: Array<[string, "idle" | "immediate"]>) {
  return values.reduce(
    (acc, [value, mode]) => recordEdit(acc, { value }, mode),
    history,
  );
}

describe("recording edits", () => {
  it("makes one entry per discrete change", () => {
    let history = createHistory<Doc>(start);
    history = edits(history, ["a", "immediate"], ["b", "immediate"]);

    expect(history.present.value).toBe("b");
    expect(history.past).toHaveLength(2);
  });

  it("makes one entry for a whole drag, not one per frame", () => {
    let history = createHistory<Doc>(start);

    // A slider drag: many mid-gesture frames, then the pointer release.
    history = edits(
      history,
      ["frame-1", "idle"],
      ["frame-2", "idle"],
      ["frame-3", "idle"],
      ["frame-4", "idle"],
    );
    history = closeInteraction(history);

    expect(history.past).toHaveLength(1);
    expect(history.present.value).toBe("frame-4");

    const undone = undo(history);
    expect(undone.present.value).toBe("start");
  });

  it("makes one entry for a burst of typing", () => {
    let history = createHistory<Doc>(start);
    history = edits(history, ["a", "idle"], ["ab", "idle"], ["abc", "idle"]);
    history = closeInteraction(history);

    expect(history.past).toHaveLength(1);
    expect(undo(history).present.value).toBe("start");
  });

  it("starts a new entry once the previous interaction closed", () => {
    let history = createHistory<Doc>(start);
    history = edits(history, ["drag-a", "idle"]);
    history = closeInteraction(history);
    history = edits(history, ["drag-b", "idle"]);
    history = closeInteraction(history);

    expect(history.past).toHaveLength(2);
    expect(undo(history).present.value).toBe("drag-a");
  });

  it("closes an open interaction when a discrete edit interrupts it", () => {
    let history = createHistory<Doc>(start);
    history = edits(history, ["typing", "idle"], ["clicked", "immediate"]);

    expect(history.past.map((entry) => entry.value)).toEqual(["start", "typing"]);
  });

  it("ignores an edit that changes nothing", () => {
    let history = createHistory<Doc>(start);
    history = recordEdit(history, start, "immediate");

    expect(history.past).toHaveLength(0);
  });
});

describe("undo and redo", () => {
  it("steps backwards and forwards through discrete edits", () => {
    let history = createHistory<Doc>(start);
    history = edits(history, ["a", "immediate"], ["b", "immediate"]);

    history = undo(history);
    expect(history.present.value).toBe("a");
    history = undo(history);
    expect(history.present.value).toBe("start");

    history = redo(history);
    expect(history.present.value).toBe("a");
    history = redo(history);
    expect(history.present.value).toBe("b");
  });

  it("closes an open interaction before undoing it", () => {
    let history = createHistory<Doc>(start);
    // Undo pressed mid-drag, with no pointer release yet.
    history = edits(history, ["mid-drag", "idle"]);

    history = undo(history);

    expect(history.present.value).toBe("start");
    expect(canRedo(history)).toBe(true);
    expect(redo(history).present.value).toBe("mid-drag");
  });

  it("does nothing at either end of the stack", () => {
    const history = createHistory<Doc>(start);

    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  it("reports what is available, so the buttons can disable", () => {
    let history = createHistory<Doc>(start);
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);

    history = recordEdit(history, { value: "a" }, "immediate");
    expect(canUndo(history)).toBe(true);
    expect(canRedo(history)).toBe(false);

    history = undo(history);
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(true);
  });

  it("drops the redo stack when a new edit follows an undo", () => {
    let history = createHistory<Doc>(start);
    history = edits(history, ["a", "immediate"], ["b", "immediate"]);
    history = undo(history);
    expect(canRedo(history)).toBe(true);

    history = recordEdit(history, { value: "different" }, "immediate");

    expect(canRedo(history)).toBe(false);
    expect(history.present.value).toBe("different");
  });
});

describe("a save acknowledgement is not an edit", () => {
  it("adopts the confirmed document without adding an entry", () => {
    let history = createHistory<Doc>(start);
    history = recordEdit(history, { value: "a" }, "immediate");
    const pastBefore = history.past;

    history = applyConfirmedSave(history, { value: "a", version: 4 });

    expect(history.present).toEqual({ value: "a", version: 4 });
    expect(history.past).toBe(pastBefore);
  });

  it("leaves the redo stack intact", () => {
    let history = createHistory<Doc>(start);
    history = edits(history, ["a", "immediate"], ["b", "immediate"]);
    history = undo(history);

    history = applyConfirmedSave(history, { value: "a", version: 7 });

    expect(canRedo(history)).toBe(true);
    expect(redo(history).present.value).toBe("b");
  });

  it("does not close an interaction the user is still in", () => {
    let history = createHistory<Doc>(start);
    history = recordEdit(history, { value: "drag-1" }, "idle");

    // An autosave lands mid-drag; the drag continues afterwards.
    history = applyConfirmedSave(history, { value: "drag-1", version: 2 });
    history = recordEdit(history, { value: "drag-2" }, "idle");
    history = closeInteraction(history);

    expect(history.past).toHaveLength(1);
    expect(undo(history).present.value).toBe("start");
  });
});

describe("keyboard shortcuts", () => {
  const key = (over: Partial<Record<string, unknown>> & { key: string }) => ({
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...over,
  });

  it("maps the macOS shortcuts", () => {
    expect(historyShortcut(key({ key: "z", metaKey: true }))).toBe("undo");
    expect(historyShortcut(key({ key: "z", metaKey: true, shiftKey: true }))).toBe("redo");
  });

  it("maps the Windows shortcuts", () => {
    expect(historyShortcut(key({ key: "z", ctrlKey: true }))).toBe("undo");
    expect(historyShortcut(key({ key: "y", ctrlKey: true }))).toBe("redo");
    // Windows and Linux apps commonly accept this for redo too.
    expect(historyShortcut(key({ key: "z", ctrlKey: true, shiftKey: true }))).toBe("redo");
  });

  it("accepts an uppercase key, which is what Shift produces", () => {
    expect(historyShortcut(key({ key: "Z", metaKey: true, shiftKey: true }))).toBe("redo");
  });

  it("ignores everything else", () => {
    expect(historyShortcut(key({ key: "z" }))).toBeNull();
    expect(historyShortcut(key({ key: "s", metaKey: true }))).toBeNull();
    expect(historyShortcut(key({ key: "y", metaKey: true }))).toBeNull();
  });

  it("leaves a text field's own undo alone", () => {
    expect(isTextEntryTarget({ tagName: "INPUT", isContentEditable: false })).toBe(true);
    expect(isTextEntryTarget({ tagName: "TEXTAREA", isContentEditable: false })).toBe(true);
    expect(isTextEntryTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTextEntryTarget({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});
