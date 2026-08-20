/**
 * Editor persistence, separated from preview.
 *
 * The preview renders from local state on the input event. Nothing in this file sits between an
 * input and what the user sees. Its only job is deciding *when* to write the document to the
 * backend, and *which* responses are still worth believing.
 *
 * Two rules drive the design:
 *
 * 1. One interaction is one save. A drag emits a frame per pointer move; only the last one is
 *    worth a request, and edits made while a request is open coalesce into a single follow-up.
 * 2. `Saved` describes the document the user is looking at, or it is not shown. A response whose
 *    request has been superseded cannot claim the editor is saved, because it describes content
 *    the user has already moved past.
 *
 * The version is the exception to rule 2, and the distinction matters: it describes the backend's
 * row, not the user's document. It advances monotonically whatever the user does next, and the
 * following save needs it as its optimistic-concurrency base. Discarding it alongside the stale
 * document makes the next save collide with the row its own predecessor created.
 */

/** Typing pauses for this long before the document is written. */
export const DEFAULT_IDLE_SAVE_MS = 300;

export type SavePhase = "idle" | "pending" | "saving" | "saved" | "error" | "conflict";

/**
 * `immediate` is the natural commit point of an interaction: a pointer release, Enter, or blur.
 * `idle` is a keystroke, which commits once typing pauses.
 */
export type CommitMode = "immediate" | "idle";

export type SaveOutcome<T> =
  | { kind: "saved"; version: number; state: T }
  | { kind: "conflict" }
  | { kind: "error" };

export type SaveConfirmation<T> = {
  version: number;
  state: T;
  /** True when a newer edit landed while this request was open. */
  superseded: boolean;
};

export type SaveScheduler<T> = {
  /** Records an edit and schedules the write its commit mode calls for. */
  markDirty(doc: T, mode: CommitMode): void;
  /** Manual "Save changes": writes anything pending right now. */
  flush(): void;
  /** Current phase, for the status label. */
  phase(): SavePhase;
  /**
   * Called for every successful write. `superseded` says whether the document it confirms is
   * still what the user is looking at; the version is authoritative either way.
   */
  onSaved(listener: (confirmation: SaveConfirmation<T>) => void): void;
  /** Cancels pending work and ignores every response still in flight. */
  dispose(): void;
  /**
   * Re-enables a scheduler that was disposed by a remount rather than a real unmount. React
   * Strict Mode runs an effect's cleanup once immediately after mounting, so a scheduler that
   * treated that cleanup as final would stop saving for the life of the page in development.
   */
  resume(): void;
};

export function createSaveScheduler<T>(options: {
  save: (doc: T) => Promise<SaveOutcome<T>>;
  onPhase: (phase: SavePhase) => void;
  idleMs?: number;
}): SaveScheduler<T> {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_SAVE_MS;

  let phase: SavePhase = "idle";
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The newest edit not yet handed to a request, with the commit mode that produced it. */
  let pending: { doc: T; mode: CommitMode } | null = null;
  /** Monotonic request id, so a settled request can never settle twice. */
  let issued = 0;
  let inFlight = 0;
  let disposed = false;
  const savedListeners: Array<(confirmation: SaveConfirmation<T>) => void> = [];

  function setPhase(next: SavePhase) {
    if (phase === next) return;
    phase = next;
    options.onPhase(next);
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** Re-arms an idle wait for a queued keystroke, or writes a queued commit straight away. */
  function scheduleQueued() {
    if (disposed || !pending) return;
    if (pending.mode === "immediate") {
      startSave();
      return;
    }
    setPhase("pending");
    clearTimer();
    timer = setTimeout(startSave, idleMs);
  }

  function startSave() {
    if (disposed || !pending || inFlight !== 0) return;

    clearTimer();
    const doc = pending.doc;
    pending = null;
    issued += 1;
    const requestId = issued;
    inFlight = requestId;
    setPhase("saving");

    const settle = (outcome: SaveOutcome<T>) => {
      if (disposed || requestId !== inFlight) return;
      inFlight = 0;

      // Superseded: an edit landed while this request was open, so the document it confirms is
      // already behind what the user sees.
      const superseded = pending !== null;

      if (outcome.kind === "saved") {
        // The version is reported either way. It belongs to the backend's row rather than to the
        // user's document, and the queued write needs it as its base — withholding it would make
        // that write collide with the row this one just created.
        for (const listener of savedListeners) {
          listener({ version: outcome.version, state: outcome.state, superseded });
        }
      }

      if (superseded) {
        // No phase claim: the queued write produces the authoritative answer.
        scheduleQueued();
        return;
      }

      if (outcome.kind === "saved") {
        setPhase("saved");
      } else {
        setPhase(outcome.kind === "conflict" ? "conflict" : "error");
      }
    };

    Promise.resolve(options.save(doc)).then(settle, () => settle({ kind: "error" }));
  }

  return {
    markDirty(doc, mode) {
      if (disposed) return;
      pending = { doc, mode };

      if (inFlight !== 0) {
        // A request is open. The queued document is written when it settles — one follow-up,
        // however many frames arrive in the meantime.
        clearTimer();
        return;
      }

      if (mode === "immediate") {
        startSave();
        return;
      }

      setPhase("pending");
      clearTimer();
      timer = setTimeout(startSave, idleMs);
    },

    flush() {
      if (disposed || !pending) return;
      if (inFlight !== 0) {
        // A request is open; make sure the queued document is written the moment it settles.
        pending = { doc: pending.doc, mode: "immediate" };
        clearTimer();
        return;
      }
      startSave();
    },

    phase() {
      return phase;
    },

    onSaved(listener) {
      savedListeners.push(listener);
    },

    dispose() {
      disposed = true;
      clearTimer();
      pending = null;
    },

    resume() {
      disposed = false;
    },
  };
}
