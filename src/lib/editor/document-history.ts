export type DocumentHistory<T> = {
  past: T[];
  present: T;
  future: T[];
  activeGroup: string | null;
};

type DocumentHistoryAction<T> =
  | { type: "edit"; document: T; group?: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "end-group"; group?: string }
  | { type: "sync"; document: T };

export function createDocumentHistory<T>(document: T): DocumentHistory<T> {
  return { past: [], present: document, future: [], activeGroup: null };
}

export function updateDocumentHistory<T>(
  history: DocumentHistory<T>,
  action: DocumentHistoryAction<T>,
): DocumentHistory<T> {
  if (action.type === "edit") {
    if (Object.is(action.document, history.present)) return history;
    if (action.group && action.group === history.activeGroup) {
      return {
        ...history,
        present: action.document,
        future: [],
      };
    }
    return {
      past: [...history.past, history.present],
      present: action.document,
      future: [],
      activeGroup: action.group ?? null,
    };
  }

  if (action.type === "end-group") {
    if (action.group && action.group !== history.activeGroup) return history;
    if (history.activeGroup === null) return history;
    return { ...history, activeGroup: null };
  }

  if (action.type === "sync") {
    if (Object.is(action.document, history.present)) return history;
    return { ...history, present: action.document };
  }

  if (action.type === "undo") {
    const previous = history.past.at(-1);
    if (previous === undefined) return history;
    return {
      past: history.past.slice(0, -1),
      present: previous,
      future: [history.present, ...history.future],
      activeGroup: null,
    };
  }

  if (action.type === "redo") {
    const next = history.future[0];
    if (next === undefined) return history;
    return {
      past: [...history.past, history.present],
      present: next,
      future: history.future.slice(1),
      activeGroup: null,
    };
  }

  return history;
}
