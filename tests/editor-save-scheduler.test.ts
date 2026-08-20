import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSaveScheduler,
  DEFAULT_IDLE_SAVE_MS,
  type SaveOutcome,
  type SavePhase,
} from "@/lib/editor/save-scheduler";

type Doc = { text: string };

/**
 * A save the test controls: each call parks until the test resolves it, so "what happens while a
 * save is in flight" is expressible rather than a matter of timing luck.
 */
function controllableSave() {
  const calls: Array<{ doc: Doc; resolve: (outcome: SaveOutcome<Doc>) => void }> = [];
  const save = vi.fn(
    (doc: Doc) =>
      new Promise<SaveOutcome<Doc>>((resolve) => {
        calls.push({ doc, resolve });
      }),
  );
  return { save, calls };
}

function saved(version: number, text: string): SaveOutcome<Doc> {
  return { kind: "saved", version, state: { text } };
}

function harness(options?: { idleMs?: number }) {
  const { save, calls } = controllableSave();
  const phases: SavePhase[] = [];
  const scheduler = createSaveScheduler<Doc>({
    idleMs: options?.idleMs,
    save,
    onPhase: (phase) => phases.push(phase),
  });
  return { scheduler, save, calls, phases };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("keyboard-style edits save after a short idle", () => {
  it("waits the idle delay before saving", async () => {
    const { scheduler, save } = harness();

    scheduler.markDirty({ text: "a" }, "idle");
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_SAVE_MS - 1);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of typing into one save carrying the last document", async () => {
    const { scheduler, save, calls } = harness();

    for (const text of ["a", "ab", "abc"]) {
      scheduler.markDirty({ text }, "idle");
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_SAVE_MS);

    expect(save).toHaveBeenCalledTimes(1);
    expect(calls[0].doc).toEqual({ text: "abc" });
  });

  it("uses the configured idle delay", async () => {
    const { scheduler, save } = harness({ idleMs: 1000 });

    scheduler.markDirty({ text: "a" }, "idle");
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_SAVE_MS);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000 - DEFAULT_IDLE_SAVE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("releasing a control saves immediately", () => {
  it("does not wait for the idle delay", () => {
    const { scheduler, save } = harness();

    scheduler.markDirty({ text: "a" }, "immediate");

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending idle save rather than saving twice", async () => {
    const { scheduler, save, calls } = harness();

    scheduler.markDirty({ text: "dragging" }, "idle");
    scheduler.markDirty({ text: "released" }, "immediate");
    calls[0].resolve(saved(2, "released"));
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_SAVE_MS * 2);

    expect(save).toHaveBeenCalledTimes(1);
    expect(calls[0].doc).toEqual({ text: "released" });
  });
});

describe("one interaction produces one save", () => {
  it("queues edits made while a save is in flight into a single follow-up", async () => {
    const { scheduler, save, calls } = harness();

    scheduler.markDirty({ text: "frame-1" }, "immediate");
    expect(save).toHaveBeenCalledTimes(1);

    // Every subsequent drag frame lands while the first request is still open.
    for (const text of ["frame-2", "frame-3", "frame-4"]) {
      scheduler.markDirty({ text }, "immediate");
    }
    expect(save).toHaveBeenCalledTimes(1);

    calls[0].resolve(saved(2, "frame-1"));
    await vi.advanceTimersByTimeAsync(0);

    expect(save).toHaveBeenCalledTimes(2);
    expect(calls[1].doc).toEqual({ text: "frame-4" });
  });

  it("stops after the queued save when no further edits arrive", async () => {
    const { scheduler, save, calls } = harness();

    scheduler.markDirty({ text: "a" }, "immediate");
    scheduler.markDirty({ text: "b" }, "immediate");
    calls[0].resolve(saved(2, "a"));
    await vi.advanceTimersByTimeAsync(0);
    calls[1].resolve(saved(3, "b"));
    await vi.advanceTimersByTimeAsync(0);

    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe("Saved is never reported for content the user has moved past", () => {
  it("makes no claim from a superseded response", async () => {
    const { scheduler, calls, phases } = harness();

    scheduler.markDirty({ text: "first" }, "immediate");
    scheduler.markDirty({ text: "second" }, "immediate");

    // The first request confirms, but its document is already stale.
    calls[0].resolve(saved(2, "first"));
    await vi.advanceTimersByTimeAsync(0);

    expect(phases).not.toContain("saved");
    expect(scheduler.phase()).toBe("saving");
  });

  it("reports saved exactly once, when the latest response lands", async () => {
    const { scheduler, calls, phases } = harness();

    scheduler.markDirty({ text: "first" }, "immediate");
    scheduler.markDirty({ text: "second" }, "immediate");
    calls[0].resolve(saved(2, "first"));
    await vi.advanceTimersByTimeAsync(0);
    calls[1].resolve(saved(3, "second"));
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.phase()).toBe("saved");
    expect(phases.filter((phase) => phase === "saved")).toHaveLength(1);
  });

  it("marks a superseded confirmation as such, and the current one as current", async () => {
    const { scheduler, calls } = harness();
    const confirmed: Array<{ version: number; superseded: boolean }> = [];
    scheduler.onSaved(({ version, superseded }) => confirmed.push({ version, superseded }));

    scheduler.markDirty({ text: "first" }, "immediate");
    scheduler.markDirty({ text: "second" }, "immediate");
    calls[0].resolve(saved(2, "first"));
    await vi.advanceTimersByTimeAsync(0);
    calls[1].resolve(saved(3, "second"));
    await vi.advanceTimersByTimeAsync(0);

    expect(confirmed).toEqual([
      { version: 2, superseded: true },
      { version: 3, superseded: false },
    ]);
  });

  /**
   * The regression an end-to-end run caught: dropping a superseded response whole also dropped
   * the version it confirmed, so the queued write reused a stale base and the backend rejected it
   * as a conflict with the row its own predecessor had just created.
   */
  it("reports the version from a superseded response so the queued save has the right base", async () => {
    const { scheduler, calls } = harness();
    const versions: number[] = [];
    scheduler.onSaved(({ version }) => versions.push(version));

    scheduler.markDirty({ text: "first" }, "immediate");
    scheduler.markDirty({ text: "second" }, "immediate");
    calls[0].resolve(saved(2, "first"));
    await vi.advanceTimersByTimeAsync(0);

    expect(versions).toEqual([2]);
  });

  it("returns to pending, not saved, when an edit arrives while the save is open", async () => {
    const { scheduler, calls, phases } = harness();

    scheduler.markDirty({ text: "a" }, "immediate");
    scheduler.markDirty({ text: "b" }, "idle");
    calls[0].resolve(saved(2, "a"));
    await vi.advanceTimersByTimeAsync(0);

    expect(phases).not.toContain("saved");
    expect(scheduler.phase()).toBe("pending");
  });
});

describe("failures", () => {
  it("reports a conflict from the latest request", async () => {
    const { scheduler, calls } = harness();

    scheduler.markDirty({ text: "a" }, "immediate");
    calls[0].resolve({ kind: "conflict" });
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.phase()).toBe("conflict");
  });

  it("reports an error from the latest request", async () => {
    const { scheduler, calls } = harness();

    scheduler.markDirty({ text: "a" }, "immediate");
    calls[0].resolve({ kind: "error" });
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.phase()).toBe("error");
  });

  it("treats a thrown save as an error rather than hanging in saving", async () => {
    const save = vi.fn(async () => {
      throw new Error("network down");
    });
    const scheduler = createSaveScheduler<Doc>({ save, onPhase: () => {} });

    scheduler.markDirty({ text: "a" }, "immediate");
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.phase()).toBe("error");
  });

  it("does not report a superseded failure over a later success", async () => {
    const { scheduler, calls } = harness();

    scheduler.markDirty({ text: "a" }, "immediate");
    scheduler.markDirty({ text: "b" }, "immediate");
    calls[0].resolve({ kind: "error" });
    await vi.advanceTimersByTimeAsync(0);
    calls[1].resolve(saved(3, "b"));
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.phase()).toBe("saved");
  });
});

describe("manual save", () => {
  it("flushes a pending idle save immediately", () => {
    const { scheduler, save, calls } = harness();

    scheduler.markDirty({ text: "a" }, "idle");
    scheduler.flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(calls[0].doc).toEqual({ text: "a" });
  });

  it("does nothing when there is nothing to save", () => {
    const { scheduler, save } = harness();

    scheduler.flush();

    expect(save).not.toHaveBeenCalled();
  });
});

describe("disposal", () => {
  it("cancels a pending save so an unmounted editor writes nothing", async () => {
    const { scheduler, save } = harness();

    scheduler.markDirty({ text: "a" }, "idle");
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_SAVE_MS * 2);

    expect(save).not.toHaveBeenCalled();
  });

  it("ignores a response that lands after disposal", async () => {
    const { scheduler, calls, phases } = harness();

    scheduler.markDirty({ text: "a" }, "immediate");
    scheduler.dispose();
    calls[0].resolve(saved(2, "a"));
    await vi.advanceTimersByTimeAsync(0);

    expect(phases).not.toContain("saved");
  });
});

describe("Strict Mode remounts", () => {
  it("saves again after a cleanup that was not a real unmount", async () => {
    const { scheduler, save } = harness();

    // React Strict Mode: mount, immediate cleanup, remount.
    scheduler.dispose();
    scheduler.resume();

    scheduler.markDirty({ text: "a" }, "idle");
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_SAVE_MS);

    expect(save).toHaveBeenCalledTimes(1);
  });

  it("still writes nothing after a real unmount", async () => {
    const { scheduler, save } = harness();

    scheduler.dispose();
    scheduler.markDirty({ text: "a" }, "immediate");
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_SAVE_MS * 2);

    expect(save).not.toHaveBeenCalled();
  });
});
