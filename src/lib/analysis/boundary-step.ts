import { z } from "zod";

/**
 * Phase 1 lab boundary step (docs/FOUNDER_BRIEF.md, quality test 1). Candidate windows are a
 * fixed 20, 55 or 90 seconds, so a clip can stop before its thought lands or start on the
 * Scripture reading. Lab sermon 1b, 2026-10-17: Jake failed three of six first picks on this
 * ("should have kept going", "stops at the wrong time", "shouldn't start by reading a verse").
 *
 * The model reads whole transcript sentences around a clip and picks where the thought starts
 * and where the point lands. Code then enforces what can be checked: whole sentences, 15 seconds
 * to under 60, and no start on a Scripture reading.
 */

export const BOUNDARY_MIN_MS = 15_000;
// Jake, 2026-10-18: "keep the clips under 60 seconds."
export const BOUNDARY_MAX_MS = 59_900;
export const BOUNDARY_CONTEXT_MS = 90_000;

export type BoundaryUnit = { idx: number; startMs: number; endMs: number; text: string };
export type BoundaryContext = { units: BoundaryUnit[]; currentStart: number; currentEnd: number };

export const BoundaryChoiceSchema = z.object({
  startUnit: z.number().int(),
  endUnit: z.number().int(),
  reason: z.string(),
});
export type BoundaryChoice = Pick<z.infer<typeof BoundaryChoiceSchema>, "startUnit" | "endUnit">;

const BOOKS =
  "genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|" +
  "psalms?|proverbs|ecclesiastes|song of solomon|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|" +
  "jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|" +
  "galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation";

const READING_STARTS = [
  // "The Bible says First Peter chapter five, verse five, ..."
  /^\W*(the bible says|the word of god says|the scripture says|scripture says)\b/i,
  // "Turn with me to Luke chapter 22." / "Take your Bibles and open them to ..."
  /^\W*(turn|open)\b.{0,30}\b(to|bibles?)\b/i,
  /\b(take|open|turn)\b[^.]{0,40}\bbibles?\b/i,
  // "Ephesians 2:8-9, ..." / "First Peter chapter five, and I'm gonna read ..."
  new RegExp(`^\\W*((first|second|third|1st|2nd|3rd|[123]|i{1,3})\\s+)?(${BOOKS})\\s+(\\d+:\\d+|chapter\\b)`, "i"),
  /\bchapter\s+\w+,?\s+(and\s+)?verses?\s+\w+/i,
  /\b(let me read|let's read|(gonna|going to|i'?m gonna) (begin to )?read|begin to read)\b/i,
];

/** True when a sentence opens or announces a Scripture reading rather than preaching on it. */
export function looksLikeScriptureReadingStart(text: string): boolean {
  return READING_STARTS.some((pattern) => pattern.test(text));
}

const quoteBalance = (text: string) => (text.match(/["“”]/g) ?? []).length % 2;

const SPEAKERS = "he|she|they|it|jesus|paul|peter|god|the lord|the bible|scripture|the word";
const QUOTATION_LEADS = [
  // 'He says, "Your adversary the devil".' / "And Jesus said this to Peter."
  new RegExp(`^\\W*((and|so|then|now|well)\\W+)*(${SPEAKERS})\\s+(says|said|writes|wrote|tells us)\\b`, "i"),
  // "... 'cause notice what he says there."
  /\b(says|said|writes|wrote)\b(\s+\w+){0,2}[\s.,:"”']*$/i,
];

/**
 * True when a sentence only leads into a quotation — announcing it, or opening a quote that the
 * next sentence finishes — so a clip ending there stops before the words it promised. Lab sermon
 * 1c clip 5 ended on two such lines after Jake's chosen end, "Secondly, you need to resist him."
 */
export function endsOnQuotationStart(text: string): boolean {
  if (QUOTATION_LEADS.some((pattern) => pattern.test(text))) return true;
  if (looksLikeScriptureReadingStart(text)) return true;
  // An opening quote mark with no closing one: the quotation runs on into the next sentence.
  return quoteBalance(text) === 1 && !/["”]\W*$/.test(text.trim());
}

/**
 * Jake's corrections of lab sermon 1c (2026-10-18), shown to the model as worked examples. They
 * come from sermon 1 only, so the step is judged on sermons 2 and 3.
 */
const WORKED_EXAMPLES =
  "Worked examples from the founder's review of an earlier sermon:\n" +
  "1. A clip started on \"I mean, here's this big tough guy fisherman, right?\" (background to a story) and ended on " +
  "\"because he's setting you up.\" Correct: start on \"See, I, I'm speaking to somebody today, and you say, 'Preacher, " +
  "man, things are going pretty good for me today.'\" (he turns to the listener) and end on \"Be sober. Be vigilant.\" " +
  "(the short charge that lands it). 42 seconds.\n" +
  "2. A clip started on \"Now, think about this.\" and ended on 'He says, \"Your adversary the devil\".' Correct: same " +
  "start, end on \"Secondly, you need to resist him.\" (the last item of his two-point list). The lines after it only " +
  "lead into the next verse. 58 seconds.\n" +
  "3. A clip ended on Peter's objection, '\"Oh, no, you're not gonna wash my feet, Jesus.\"' The founder said it stopped " +
  "too early: the preacher had not finished his point. Jesus's reply and the meaning came after. Never end in the middle " +
  "of a dialogue; if the whole story and its point will not fit under 60 seconds, start later in the story.\n\n";

/** Whole sentences from `contextMs` before the clip to `contextMs` after it. */
export function boundaryContext(
  segments: BoundaryUnit[],
  clip: { startMs: number; endMs: number },
  contextMs = BOUNDARY_CONTEXT_MS,
): BoundaryContext {
  const units = segments.filter((s) => s.endMs > clip.startMs - contextMs && s.startMs < clip.endMs + contextMs);
  const currentStart = Math.max(0, units.findIndex((u) => u.endMs > clip.startMs));
  let currentEnd = units.length - 1;
  while (currentEnd > currentStart && units[currentEnd].startMs >= clip.endMs) currentEnd -= 1;
  return { units, currentStart, currentEnd };
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
};

export function boundaryPrompt(context: BoundaryContext): string {
  const lines = context.units.map((u, i) => `[${i}] (${clock(u.startMs)}) ${u.text}`);
  return (
    "You are editing a short social media clip cut from a sermon. Below are numbered transcript " +
    "sentences with their times. The current clip is units " +
    `[${context.currentStart}] to [${context.currentEnd}]. Choose the best start unit and end unit for this clip's idea.\n\n` +
    "Rules:\n" +
    "- Start where the thought starts: the first sentence a viewer with no context needs to follow this idea. " +
    "Prefer an opening line that catches attention.\n" +
    "- Start on a line that speaks directly to the listener or states the point. Do not start on background " +
    "or set-up that only leads into a story.\n" +
    "- Never start on the Scripture reading: not the preacher reading the passage aloud, and not him announcing " +
    "the book, chapter or verse, or asking people to turn there. Start where he begins to explain or apply it. " +
    "A short verse he quotes inside his point is fine, but not as the first line.\n" +
    "- End where the point lands: after the payoff, the sentence that drives the point home or applies it to the " +
    "listener. Never stop in the middle of a story, a list, an argument, or a quoted verse, and never stop right " +
    "after a verse before the preacher says what it means. Do not run on into the next point.\n" +
    "- End on the punch line: the short line that sums up the point or charges the listener, often the last item " +
    "of a list or a command. Never end in the middle of a dialogue or a story, and never on a line that only " +
    "leads into a quotation (\"He says,\", \"notice what he says there\").\n" +
    "- The clip must be between 15 and 59 seconds long: always under 60 seconds. Most strong sermon clips run 30 to 55 seconds: the setup, " +
    "the explanation or story, and the payoff. Do not cut a clip short to make it tidy; a viewer must feel the point land.\n" +
    "- Never include worship singing, announcements, prayer, or the altar call or invitation.\n" +
    "- Stay on the current clip's idea. You may move the start earlier or later and the end earlier or later.\n\n" +
    WORKED_EXAMPLES +
    "Return startUnit and endUnit (both included) and a one-sentence reason.\n\n" +
    lines.join("\n")
  );
}

/**
 * Turns a model choice into a range, or null when it breaks a rule (the caller keeps the old
 * range). A start on a Scripture reading moves past the reading — through the closing quote mark
 * when the reading is quoted. An end on a line that only leads into a quotation moves back to the
 * line before. The clip must still be long enough after both.
 */
export function applyBoundaryChoice(
  context: BoundaryContext,
  choice: BoundaryChoice,
  limits: { minMs: number; maxMs: number } = { minMs: BOUNDARY_MIN_MS, maxMs: BOUNDARY_MAX_MS },
): { startMs: number; endMs: number; adjustedForScripture: boolean; adjustedEnd: boolean } | null {
  const { units } = context;
  let { startUnit, endUnit } = choice;
  if (!Number.isInteger(startUnit) || !Number.isInteger(endUnit)) return null;
  if (startUnit < 0 || endUnit >= units.length || startUnit > endUnit) return null;

  let adjustedForScripture = false;
  while (startUnit <= endUnit && looksLikeScriptureReadingStart(units[startUnit].text)) {
    adjustedForScripture = true;
    // A quote opened in the reading continues until a sentence closes it.
    let open = quoteBalance(units[startUnit].text) === 1;
    startUnit += 1;
    while (open && startUnit <= endUnit) {
      if (quoteBalance(units[startUnit].text) === 1) open = false;
      startUnit += 1;
    }
  }
  if (startUnit > endUnit) return null;

  let adjustedEnd = false;
  while (endUnit > startUnit && endsOnQuotationStart(units[endUnit].text)) {
    adjustedEnd = true;
    endUnit -= 1;
  }

  const startMs = units[startUnit].startMs;
  const endMs = units[endUnit].endMs;
  const duration = endMs - startMs;
  if (duration < limits.minMs || duration > limits.maxMs) return null;
  return { startMs, endMs, adjustedForScripture, adjustedEnd };
}
