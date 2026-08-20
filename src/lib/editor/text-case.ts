/**
 * The one text-case model, shared by captions and the title overlay.
 *
 * There is exactly one implementation on purpose. Captions and titles offer the same five options,
 * and building them separately is how the two drift apart — one gaining an option, or treating an
 * apostrophe differently, until the same words render two ways in the same frame.
 *
 * It matters more than it looks, because the browser preview and the burned-in render are two
 * different text engines. The preview previously leaned on CSS `text-transform`, which the ASS
 * generator has no access to, so parity depended on two languages agreeing about casing. Now both
 * lay out the string this function returns, and Sentence case and Title Case become expressible at
 * all — CSS cannot produce either.
 */

export const TEXT_CASES = ["uppercase", "sentence", "title", "lowercase", "original"] as const;

export type TextCase = (typeof TEXT_CASES)[number];

/** The default for anything new: captions and the title overlay both start here. */
export const DEFAULT_TEXT_CASE: TextCase = "uppercase";

/** Presentation order and labels for the controls, so captions and titles read identically. */
export const TEXT_CASE_OPTIONS: ReadonlyArray<{ value: TextCase; label: string }> = [
  { value: "uppercase", label: "Uppercase" },
  { value: "sentence", label: "Sentence case" },
  { value: "title", label: "Title Case" },
  { value: "lowercase", label: "lowercase" },
  { value: "original", label: "Original" },
];

export function isTextCase(value: unknown): value is TextCase {
  return typeof value === "string" && (TEXT_CASES as readonly string[]).includes(value);
}

/** A letter directly after one of these starts a new word for Title Case. */
const TITLE_WORD_BOUNDARY = /(^|[\s\-—–/([{"])(\p{L})/gu;
/**
 * A letter after a sentence terminator (and its closing quote or bracket) starts a sentence. The
 * first alternative allows leading whitespace, so an indented line still gets its capital.
 */
const SENTENCE_START = /(^\s*|[.!?]["')\]]?\s+)(\p{L})/gu;

/**
 * Standard Sentence case: flatten, then capitalise each sentence's first letter.
 *
 * This does lowercase proper nouns — "God" becomes "god" — because nothing here can tell a name
 * from any other word. That is inherent to the option rather than a defect, and it is why
 * Uppercase, not Sentence case, is the default.
 */
function toSentenceCase(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(SENTENCE_START, (_match, prefix: string, letter: string) => prefix + letter.toLocaleUpperCase());
}

function toTitleCase(text: string): string {
  // Every word is capitalised, including short ones. A style that lowercases "of" and "the" is a
  // judgement call per phrase, and a caption that silently disagrees with the speaker's own
  // capitalisation is worse than one that is consistent.
  return text
    .toLocaleLowerCase()
    .replace(TITLE_WORD_BOUNDARY, (_match, prefix: string, letter: string) => prefix + letter.toLocaleUpperCase());
}

/** The single transformation. Measurement, the browser preview, and the ASS generator all use it. */
export function applyTextCase(text: string, textCase: TextCase): string {
  switch (textCase) {
    case "uppercase":
      return text.toLocaleUpperCase();
    case "lowercase":
      return text.toLocaleLowerCase();
    case "sentence":
      return toSentenceCase(text);
    case "title":
      return toTitleCase(text);
    case "original":
      return text;
  }
}

/**
 * Decides which case a stored document means.
 *
 * Documents written before this model carry only `captions.overrides.uppercase`. That boolean is
 * authoritative for those clips: `true` rendered upper-cased text and `false` rendered the
 * transcript untouched, so they map to Uppercase and Original and nothing re-renders differently.
 * `DEFAULT_TEXT_CASE` deliberately does not apply to them — defaulting an old clip to Uppercase
 * would change a video a church may already have published.
 */
export function resolveTextCase(params: {
  textCase?: TextCase;
  legacyUppercase?: boolean;
  fallback: TextCase;
}): TextCase {
  if (isTextCase(params.textCase)) return params.textCase;
  if (params.legacyUppercase !== undefined) {
    return params.legacyUppercase ? "uppercase" : "original";
  }
  return params.fallback;
}
