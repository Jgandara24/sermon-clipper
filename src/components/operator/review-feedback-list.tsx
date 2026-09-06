"use client";

import { ReviewFeedbackCategory, ReviewFeedbackSeverity } from "@prisma/client";

/**
 * The findings a reviewer is writing, as an editable list.
 *
 * A review carries any number of them and the product owner's rule is that there is no practical
 * limit, so the list grows rather than offering a fixed set of slots. Each row renders the same
 * repeated field names — `feedbackCategory`, `feedbackNote`, and so on — which is how a variable
 * number of rows reaches a Server Action through `FormData.getAll`.
 *
 * A blank row sits at the bottom for the next thought. Submitting with it untouched is not an
 * error; the action drops any row whose note is empty.
 */

export type DraftFinding = {
  key: string;
  category: ReviewFeedbackCategory;
  severity: ReviewFeedbackSeverity;
  note: string;
  startMs: string;
  endMs: string;
};

let nextKey = 0;

export function emptyFinding(): DraftFinding {
  nextKey += 1;
  return {
    key: `finding-${nextKey}`,
    category: ReviewFeedbackCategory.BOUNDARY,
    severity: ReviewFeedbackSeverity.MAJOR,
    note: "",
    startMs: "",
    endMs: "",
  };
}

/** What each category costs, so the reviewer knows before they submit, not after. */
const CATEGORY_HINT: Record<ReviewFeedbackCategory, string> = {
  [ReviewFeedbackCategory.CONTENT]: "needs a different clip",
  [ReviewFeedbackCategory.FORBIDDEN_CONTENT]: "needs a different clip unless it sits at an edge",
  [ReviewFeedbackCategory.BOUNDARY]: "fixable by re-editing",
  [ReviewFeedbackCategory.VISUAL_CROP]: "fixable by re-editing",
  [ReviewFeedbackCategory.CAPTION]: "fixable by re-editing",
  [ReviewFeedbackCategory.AUDIO_LEVEL]: "fixable by re-editing",
  [ReviewFeedbackCategory.TITLE_HOOK]: "fixable by re-editing",
};

export function ReviewFeedbackList({
  findings,
  onChange,
  disabled = false,
}: {
  findings: DraftFinding[];
  onChange: (findings: DraftFinding[]) => void;
  disabled?: boolean;
}) {
  function update(key: string, patch: Partial<DraftFinding>) {
    onChange(findings.map((finding) => (finding.key === key ? { ...finding, ...patch } : finding)));
  }

  return (
    <div className="grid gap-3">
      {findings.map((finding, index) => (
        <fieldset
          key={finding.key}
          data-testid="review-finding"
          className="grid gap-2 rounded-lg border border-stone-200 bg-white p-3"
        >
          <legend className="px-1 text-xs text-stone-500">Finding {index + 1}</legend>

          <label className="grid gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-stone-500">What is wrong</span>
            <select
              name="feedbackCategory"
              aria-label={`Finding ${index + 1} category`}
              value={finding.category}
              disabled={disabled}
              onChange={(event) =>
                update(finding.key, { category: event.target.value as ReviewFeedbackCategory })
              }
              className="rounded border border-stone-300 px-2 py-1"
            >
              {Object.values(ReviewFeedbackCategory).map((category) => (
                <option key={category} value={category}>
                  {category} — {CATEGORY_HINT[category]}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-stone-500">How bad</span>
            <select
              name="feedbackSeverity"
              aria-label={`Finding ${index + 1} severity`}
              value={finding.severity}
              disabled={disabled}
              onChange={(event) =>
                update(finding.key, { severity: event.target.value as ReviewFeedbackSeverity })
              }
              className="rounded border border-stone-300 px-2 py-1"
            >
              {Object.values(ReviewFeedbackSeverity).map((severity) => (
                <option key={severity} value={severity}>
                  {severity}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-stone-500">What you saw</span>
            <textarea
              name="feedbackNote"
              aria-label={`Finding ${index + 1} note`}
              value={finding.note}
              disabled={disabled}
              rows={2}
              onChange={(event) => update(finding.key, { note: event.target.value })}
              className="rounded border border-stone-300 px-2 py-1"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-stone-500">
                From (ms into the clip)
              </span>
              <input
                name="feedbackStartMs"
                aria-label={`Finding ${index + 1} start`}
                inputMode="numeric"
                value={finding.startMs}
                disabled={disabled}
                onChange={(event) => update(finding.key, { startMs: event.target.value })}
                className="rounded border border-stone-300 px-2 py-1"
              />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-stone-500">To (ms)</span>
              <input
                name="feedbackEndMs"
                aria-label={`Finding ${index + 1} end`}
                inputMode="numeric"
                value={finding.endMs}
                disabled={disabled}
                onChange={(event) => update(finding.key, { endMs: event.target.value })}
                className="rounded border border-stone-300 px-2 py-1"
              />
            </label>
          </div>
        </fieldset>
      ))}

      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...findings, emptyFinding()])}
        className="justify-self-start rounded border border-stone-300 px-3 py-1.5 text-sm"
      >
        Add another finding
      </button>
    </div>
  );
}
