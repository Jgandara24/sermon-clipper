import { z } from "zod";

/**
 * Phase 1 lab boundary step (docs/FOUNDER_BRIEF.md, quality test 1). Candidate windows are a
 * fixed 20, 55 or 90 seconds, so a clip can stop before its thought lands or start on the
 * Scripture reading. Lab sermon 1b, 2026-10-17: Jake failed three of six first picks on this
 * ("should have kept going", "stops at the wrong time", "shouldn't start by reading a verse").
 *
 * The model reads whole transcript sentences around a clip and picks where the thought starts
 * and where the point lands. Code then enforces what can be checked: whole sentences, 15 to 90
 * seconds, no start on a Scripture reading, and fix K's rules below.
 */

export const BOUNDARY_MIN_MS = 15_000;
// Jake, 2026-10-20: "if the clip's main point goes past 60 seconds and closer to something like 75
// seconds, then let it be. Try to refrain from going past 90 seconds." 30 to 60 is the sweet spot,
// which the prompt asks for; candidate windows stay under 60 (MAX_CANDIDATE_MS).
export const BOUNDARY_MAX_MS = 90_000;
// A clip cut from a point longer than BOUNDARY_MAX_MS: gate run, 2026-10-20, told only "not past 90",
// the model started lab sermon 1g clip 3 just late enough to run 89.9 seconds.
export const BOUNDARY_CUT_MAX_MS = 75_000;
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
  // "... 'cause notice what he says there." / "And this is what Jesus said." A lead word must come
  // before "what": "That's what the word of God says." and "the best is yet to come according to
  // what the word of God says." close a point (fix I1, lab sermon 4b clip 4, 2026-10-19).
  /\b(notice|listen(\s+to)?|look(\s+at)?|follow|hear|watch|see|read|this\s+is|here's|here\s+is|love|forget)\s+what\b.*\b(says|said|writes|wrote)\b(\s+\w+){0,2}[\s.,:"”']*$/i,
  // "... shows his glory, God says it again."
  /\b(says|said)\s+(it\s+)?again[\s.,:"”']*$/i,
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
 * Jake's corrections of lab sermons 1c and 3 (2026-10-18), shown to the model as worked examples.
 * They come from sermons 1 and 3, so sermon 2, and any new sermon, is the fair test of the step.
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
  "of a dialogue; if the whole story and its point will not fit in 90 seconds, keep its end and start later in the story.\n" +
  "4. A clip started on \"Now let me ask you something.\" and ended on \"That's right.\" right after '...are now the " +
  "people calling me saying, \"Bill, help me, I'm in trouble.\"' (17 seconds), because the next lines looked like a " +
  "tangent. The founder said it could be a longer clip. Correct: same start, end on \"And we're so concerned about " +
  "what our peers have to say about us that it keeps us from getting saved or selling out to the Lord Jesus Christ.\" " +
  "The preacher asks the same question again and lands it. 51 seconds.\n" +
  "5. A clip started on \"And boys, let me tell you something.\" and ran on through the laughter after the joke into " +
  "\"And guys, you get your girlfriend pregnant...\". The founder said it went slightly too long. Correct: end right " +
  "after the punch line and his \"Amen?\": \"We just stay up weeks at a time.\" \"Amen?\" 38 seconds. Never run on " +
  "into the laughter or the next idea.\n\n";

const SENTENCE_END = /[.!?…]["”'’)\]]*\s*$/;

/**
 * Transcript segments joined into whole sentences. Lab sermon 1d clip 1 (2026-10-18) ended on a
 * segment that stopped at "because that bath referred" and cut off "to salvation."; about 8 in 100
 * Scribe segments stop mid-sentence. A segment without closing punctuation runs on into the next.
 */
export function wholeSentences(segments: BoundaryUnit[]): BoundaryUnit[] {
  const units: BoundaryUnit[] = [];
  let open: BoundaryUnit | null = null;
  for (const segment of segments) {
    const text = segment.text.trim();
    const unit: BoundaryUnit = open
      ? { ...open, endMs: segment.endMs, text: `${open.text} ${text}` }
      : { idx: segment.idx, startMs: segment.startMs, endMs: segment.endMs, text };
    if (SENTENCE_END.test(text)) {
      units.push(unit);
      open = null;
    } else {
      open = unit;
    }
  }
  if (open) units.push(open);
  return units;
}

/** Whole sentences from `contextMs` before the clip to `contextMs` after it. */
export function boundaryContext(
  segments: BoundaryUnit[],
  clip: { startMs: number; endMs: number },
  contextMs = BOUNDARY_CONTEXT_MS,
): BoundaryContext {
  const units = wholeSentences(segments).filter((s) => s.endMs > clip.startMs - contextMs && s.startMs < clip.endMs + contextMs);
  const currentStart = Math.max(0, units.findIndex((u) => u.endMs > clip.startMs));
  let currentEnd = units.length - 1;
  while (currentEnd > currentStart && units[currentEnd].startMs >= clip.endMs) currentEnd -= 1;
  return { units, currentStart, currentEnd };
}

// Fix I2 (lab sermon 4b, 2026-10-19): clips 1 and 4 ended inside a list: the first of six "What
// God says about … is absolutely true." lines, and "We're gonna live …" before "We're gonna sing …".
const LIST_MIN_ITEMS = 3;
// A shorter line is a restatement, not an item: 1f clip 1's "You've got that today." between "You've
// got that today as a believer." and "You've got the sustaining grace of God."
const LIST_ITEM_MIN_WORDS = 5;
// Items may have up to two other lines between them ("God created man …" inside 4b clip 1's list).
const LIST_MAX_STEP = 3;
// A line that leads into the list says the opening words within its first six ("Brother, I'm
// tellin' you, we're gonna stand on a street of gold.").
const LIST_LEAD_IN_WORDS = 6;

/** Lower-case words without punctuation, a stammered word once ("I, I should've" reads "i shouldve"). */
function listWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  return words.filter((word, i) => word !== words[i - 1]);
}

/**
 * The list a clip would end inside: three or more lines of five words or more that open with the
 * same two words, which goes on after the end line. Null when the end is on the list's last item,
 * after it, or before it.
 */
export function endsInsideList(units: BoundaryUnit[], endUnit: number): { first: number; last: number; opening: string } | null {
  const words = units.map((unit) => listWords(unit.text));
  const opening = (i: number) => (words[i].length >= LIST_ITEM_MIN_WORDS ? words[i].slice(0, 2).join(" ") : null);
  for (let start = Math.max(0, endUnit - LIST_MAX_STEP + 1); start <= Math.min(units.length - 1, endUnit + 1); start += 1) {
    const key = opening(start);
    if (!key) continue;
    const items = [start];
    for (let i = start - 1; i >= 0 && items[0] - i <= LIST_MAX_STEP; i -= 1) if (opening(i) === key) items.unshift(i);
    for (let i = start + 1; i < units.length && i - items[items.length - 1] <= LIST_MAX_STEP; i += 1) if (opening(i) === key) items.push(i);
    if (items.length < LIST_MIN_ITEMS) continue;
    const before = items[0] - 1;
    const head = before >= 0 ? words[before].slice(0, LIST_LEAD_IN_WORDS) : [];
    const leadIn = head.some((word, i) => i > 0 && `${head[i - 1]} ${word}` === key);
    const first = leadIn ? before : items[0];
    const last = items[items.length - 1];
    if (endUnit >= first && endUnit < last) {
      const opener = units[items[0]].text.trim().split(/\s+/).slice(0, 2).join(" ").replace(/[^\p{L}\p{N}'’]+$/u, "");
      return { first, last, opening: opener };
    }
  }
  return null;
}

// Fix K1 (lab sermon 4c clips 5 and 6, 2026-10-20): "three things that are certain", then "First of
// all", and the clip ends. Jake: "it feels odd that he says here are three things and he only lists one."
const ANNOUNCED_COUNT =
  /\b(?:two|three|four|five|six|seven|[2-7])\s+(?:\w+\s+){0,2}?(?:things|ways|reasons|truths|certainties|points|keys|lessons|questions|steps|marks|facts|principles|kinds|types|areas|benefits|promises|blessings|secrets)\b/i;
const FIRST_ITEM = /\b(?:first of all|first(?:ly)?,|number one|the first (?:one|thing|is))/i;
const LATER_ITEM = /\b(?:second(?:ly)?|number two|third(?:ly)?|the next (?:one|thing)|another (?:one|thing)|finally|lastly)\b/i;

/**
 * A count the preacher announces inside the clip ("three things") whose first item the clip gives
 * ("First of all") with no later item after it. Null when the clip leaves the announcement out,
 * gives a second item, or lists the items without "first" ("two things you own: your calendar and
 * your checkbook", lab sermon 3e clip 2, which Jake passed).
 */
export function announcedListWithOnlyFirst(
  units: BoundaryUnit[],
  startUnit: number,
  endUnit: number,
): { announcement: number; first: number; count: string; firstWords: string } | null {
  for (let a = startUnit; a <= endUnit; a += 1) {
    const count = ANNOUNCED_COUNT.exec(units[a].text);
    if (!count) continue;
    for (let f = a; f <= endUnit; f += 1) {
      const text = f === a ? units[a].text.slice(count.index + count[0].length) : units[f].text;
      const first = FIRST_ITEM.exec(text);
      if (!first) continue;
      const rest = [text.slice(first.index + first[0].length), ...units.slice(f + 1, endUnit + 1).map((u) => u.text)].join(" ");
      return LATER_ITEM.test(rest) ? null : { announcement: a, first: f, count: count[0], firstWords: first[0].replace(/,$/, "") };
    }
  }
  return null;
}

// Fix K3 (lab sermon 1g clip 1, 2026-10-20): "there's grace that saves us. I- I'm sorry, sustains us.
// Excuse me." Jake: "if he were to do that in the middle of the point that's probably okay, but the
// beginning has to be clean and catch." 15 seconds: under the 90-second rule the clip starts 8.9 s
// earlier and the correction falls 12.6 s in. Over the 126 marked clips, 15 seconds finds 1g clip 1 and
// 1f clip 1 (both failed); 20 seconds also finds a passed clip's quoted "I'm sorry to tell you".
const CORRECTION_WINDOW_MS = 15_000;
// "I mean" opening a line is a filler ("I mean, here's this big tough guy fisherman"); after a comma
// it takes a word back.
const CORRECTIONS = [/\b(I'?m sorry)\b/i, /\b(excuse me)\b/i, /,\s*(I mean)\b/i, /\b(I misspoke)\b/i];
// The words he says again to fix the slip belong to it. Gate run 2, 2026-10-20: told to start after
// "Excuse me.", the model started on "Sustains us."; Jake's start is the next line.
const CORRECTION_TAIL_LINES = 2;
const CORRECTION_TAIL_WORDS = 3;
const CORRECTION_TAIL_GAP_MS = 1_500;

const correctionWords = (text: string) => CORRECTIONS.map((pattern) => pattern.exec(text)).find(Boolean)?.[1] ?? null;
const wordCount = (text: string) => text.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;

/**
 * The correction of a slip in the clip's first 15 seconds, from its first line to the last short
 * line he says again after it; null when none. A correction just before the start counts when the
 * clip starts on those repeated words.
 */
export function correctionAtStart(
  units: BoundaryUnit[],
  startUnit: number,
  endUnit: number,
): { first: number; last: number; words: string } | null {
  const found: { first: number; last: number; words: string }[] = [];
  const windowEndMs = units[startUnit].startMs + CORRECTION_WINDOW_MS;
  for (let i = Math.max(0, startUnit - CORRECTION_TAIL_LINES); i <= endUnit && units[i].startMs < windowEndMs; i += 1) {
    const words = correctionWords(units[i].text);
    if (!words) continue;
    let last = i;
    let tail = 0;
    while (last + 1 <= endUnit) {
      const next = units[last + 1];
      if (correctionWords(next.text)) last += 1;
      else if (
        tail < CORRECTION_TAIL_LINES &&
        wordCount(next.text) <= CORRECTION_TAIL_WORDS &&
        next.startMs - units[last].endMs <= CORRECTION_TAIL_GAP_MS
      ) {
        last += 1;
        tail += 1;
      } else break;
    }
    // A slip right after another one ("I'm sorry, sustains us." "Excuse me.") is the same correction.
    const before = found.at(-1);
    if (last >= startUnit) found.push(before && i <= before.last + 1 ? { ...before, last } : { first: i, last, words });
    i = last;
  }
  return found.at(-1) ?? null;
}

// Fix K4 (lab sermon 1g clip 5, 2026-10-20): the preacher's prayer after the reading is inside the
// sermon span. Jake: "The pastor is praying, this shouldn't be a clip."
const PRAYER_CLOSES = [
  /\b(in (?:jesus'?|christ'?s?)(?:\s+(?:holy|precious|mighty|wonderful|matchless))?\s+name,?\s+(?:we|i)\s+pray)\b/i,
  /\b(in (?:jesus'?|christ'?s?)(?:\s+(?:holy|precious|mighty|wonderful|matchless))?\s+name,?\s+amen)\b/i,
  /\b(all god'?s people said)\b/i,
];
// A line that speaks to the Lord: "Lord, I want to confess today ...". "God, listen to this" is
// preaching (lab sermon 1f clip 3, passed), so only "Lord" and "Father" count, and only twice.
const TO_THE_LORD = /^\W*(?:(?:and|so|now|oh|o|dear|heavenly)\s+)*(lord|father),/i;

/** The lines of a prayer inside the clip: its closing words, or two lines that speak to the Lord. */
export function prayerInClip(units: BoundaryUnit[], startUnit: number, endUnit: number): { first: number; last: number; words: string } | null {
  const closes: { unit: number; words: string }[] = [];
  const toTheLord: { unit: number; words: string }[] = [];
  for (let i = startUnit; i <= endUnit; i += 1) {
    const close = PRAYER_CLOSES.map((pattern) => pattern.exec(units[i].text)).find(Boolean);
    if (close) closes.push({ unit: i, words: close[1] });
    const lord = TO_THE_LORD.exec(units[i].text);
    if (lord) toTheLord.push({ unit: i, words: `${lord[1]},` });
  }
  if (!closes.length && toTheLord.length < 2) return null;
  const lines = [...closes, ...toTheLord].map((line) => line.unit);
  return { first: Math.min(...lines), last: Math.max(...lines), words: (closes[0] ?? toTheLord[0]).words };
}

// Fix K2 (lab sermon 5 clip 6, 2026-10-20): told that the whole 188.6-second story was too long, the
// model ended 93.2 seconds sooner, in the middle of it. Across the marked rounds, answers that ended
// more than 9 seconds sooner after that refusal failed 5 times in 7; answers that kept the end and
// started later failed 3 times in 12, none of them for the end.
export const KEEP_END_SLACK_MS = 8_000;

export const clock = (ms: number) => {
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
    "- Start on a clean line. When the preacher slips and corrects himself near the start (\"I'm sorry\", \"excuse " +
    "me\"), start after the correction.\n" +
    "- Never start on the Scripture reading: not the preacher reading the passage aloud, and not him announcing " +
    "the book, chapter or verse, or asking people to turn there. Start where he begins to explain or apply it. " +
    "A short verse he quotes inside his point is fine, but not as the first line.\n" +
    "- End where the point lands: after the payoff, the sentence that drives the point home or applies it to the " +
    "listener. Never stop in the middle of a story, a list, an argument, or a quoted verse, and never stop right " +
    "after a verse before the preacher says what it means. Do not run on into the next point.\n" +
    "- End on the punch line: the short line that sums up the point or charges the listener, often the last item " +
    "of a list or a command. Never end in the middle of a dialogue or a story, and never on a line that only " +
    "leads into a quotation (\"He says,\", \"notice what he says there\").\n" +
    "- A question needs its answer. When the preacher asks a question and then answers it, or asks the same question " +
    "again in other words, keep going and end after his answer: \"You know what God wants to do today? He wants to " +
    "heal you.\" ends on \"He wants to heal you.\" Never end the clip early to leave a question out. End on a question " +
    "only when the next line starts a new idea.\n" +
    "- When the preacher announces a number of points (\"three things\"), give all of them, or start after the " +
    "announcement. Never end after only the first.\n" +
    "- Aim for 30 to 60 seconds: the setup, the explanation or story, and the payoff. That is the sweet spot. When the " +
    "point needs more time to land, up to 75 seconds is fine. Never go past 90 seconds, and never under 15 seconds. If " +
    "the whole point will not fit in 90 seconds, keep its end and start later. Go under 30 seconds only when the lines " +
    "just before and just after belong to a different idea. When the preacher comes back to the same question or " +
    "point, keep going until he lands it; a story or aside inside the point is not a new idea. Do not cut a clip short " +
    "to make it tidy; a viewer must feel the point land.\n" +
    "- Never include worship singing, announcements, prayer (\"Lord, ...\", \"in Jesus' name we pray\"), or the altar " +
    "call or invitation.\n" +
    "- Stay on the current clip's idea. You may move the start earlier or later and the end earlier or later.\n\n" +
    WORKED_EXAMPLES +
    "Return startUnit and endUnit (both included) and a one-sentence reason.\n\n" +
    lines.join("\n")
  );
}

type BoundaryLimits = { minMs: number; maxMs: number; cutMaxMs: number };
type BoundaryRange = { startMs: number; endMs: number; adjustedForScripture: boolean; adjustedEnd: boolean };
const DEFAULT_LIMITS: BoundaryLimits = { minMs: BOUNDARY_MIN_MS, maxMs: BOUNDARY_MAX_MS, cutMaxMs: BOUNDARY_CUT_MAX_MS };

/**
 * Turns a model choice into a range, or null when it breaks a rule. A start on a Scripture
 * reading moves past the reading — through the closing quote mark when the reading is quoted. An
 * end on a line that only leads into a quotation moves back to the line before. The clip must
 * still be long enough after both.
 */
export function applyBoundaryChoice(
  context: BoundaryContext,
  choice: BoundaryChoice,
  limits: BoundaryLimits = DEFAULT_LIMITS,
): BoundaryRange | null {
  const result = evaluateBoundaryChoice(context, choice, limits, null);
  return "range" in result ? result.range : null;
}

/** Why the code refuses a choice, in a sentence the model can act on; null when it is accepted. */
export function boundaryRefusal(context: BoundaryContext, choice: BoundaryChoice, limits: BoundaryLimits = DEFAULT_LIMITS) {
  const result = evaluateBoundaryChoice(context, choice, limits, null);
  return "refused" in result ? result.refused : null;
}

/**
 * `heldEnd` is the end unit of the latest answer refused as too long (fix K2); null before one.
 * A refusal for length returns its end unit as `tooLongEnd`.
 */
function evaluateBoundaryChoice(
  context: BoundaryContext,
  choice: BoundaryChoice,
  limits: BoundaryLimits,
  heldEnd: number | null,
): { range: BoundaryRange; endUnit: number } | { refused: string; tooLongEnd?: number } {
  const { units } = context;
  let { startUnit, endUnit } = choice;
  const asked = `Units [${startUnit}] to [${endUnit}]`;
  if (
    !Number.isInteger(startUnit) ||
    !Number.isInteger(endUnit) ||
    startUnit < 0 ||
    endUnit >= units.length ||
    startUnit > endUnit
  ) {
    return { refused: `${asked} are not a valid range: both must be listed unit numbers, and the start must not come after the end.` };
  }

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
  if (startUnit > endUnit) {
    return { refused: `${asked} are all the Scripture reading. Start where the preacher explains or applies it.` };
  }

  let adjustedEnd = false;
  while (endUnit > startUnit && endsOnQuotationStart(units[endUnit].text)) {
    adjustedEnd = true;
    endUnit -= 1;
  }

  const moved =
    startUnit === choice.startUnit && endUnit === choice.endUnit ? "" : `${asked} become units [${startUnit}] to [${endUnit}] after the checks. `;
  const prayer = prayerInClip(units, startUnit, endUnit);
  if (prayer) {
    return {
      refused:
        `${moved}Units [${prayer.first}] to [${prayer.last}] are a prayer ("${prayer.words}"). Never include prayer: choose a ` +
        "range that leaves out all of the prayer, before it starts or after it ends.",
    };
  }
  const announced = announcedListWithOnlyFirst(units, startUnit, endUnit);
  if (announced) {
    return {
      refused:
        `${moved}Unit [${announced.announcement}] announces "${announced.count}", but the clip gives only the first ` +
        `("${announced.firstWords}", unit [${announced.first}]), so a viewer waits for the rest. Start after unit ` +
        `[${announced.announcement}], or end after his last item.`,
    };
  }
  const correction = correctionAtStart(units, startUnit, endUnit);
  if (correction) {
    const lines =
      correction.first === correction.last
        ? `Unit [${correction.last}] is a correction`
        : `Units [${correction.first}] to [${correction.last}] are a correction`;
    return {
      refused:
        `${moved}${lines} ("${correction.words}"): the preacher fixes a slip of the tongue in the first ` +
        `${CORRECTION_WINDOW_MS / 1000} seconds, and the opening must be clean. Start after unit [${correction.last}].`,
    };
  }

  const list = endsInsideList(units, endUnit);
  if (list) {
    return {
      refused:
        `${moved}Unit [${endUnit}] is inside a list: units [${list.first}] to [${list.last}] start the same way ("${list.opening}"), ` +
        `and the list goes on after it. End after its last item, unit [${list.last}], or before the list starts, at unit ` +
        `[${list.first - 1}] or earlier. Start later if you must to stay within ${limits.maxMs / 1000} seconds.`,
    };
  }

  if (heldEnd !== null && units[endUnit].endMs < units[heldEnd].endMs - KEEP_END_SLACK_MS) {
    const sooner = ((units[heldEnd].endMs - units[endUnit].endMs) / 1000).toFixed(1);
    return {
      refused:
        `${moved}Your last answer that ran too long ended at unit [${heldEnd}] (${clock(units[heldEnd].startMs)}), where the ` +
        `point ends. This answer ends at unit [${endUnit}], ${sooner} seconds sooner, which cuts the point short. Keep the ` +
        `end at unit [${heldEnd}] or later, and start later.`,
    };
  }

  const startMs = units[startUnit].startMs;
  const endMs = units[endUnit].endMs;
  const duration = endMs - startMs;
  const maxMs = heldEnd === null ? limits.maxMs : Math.min(limits.maxMs, limits.cutMaxMs);
  if (duration >= limits.minMs && duration <= maxMs) {
    return { range: { startMs, endMs, adjustedForScripture, adjustedEnd }, endUnit };
  }
  const steps =
    (adjustedForScripture ? " The start moved past the Scripture reading." : "") +
    (adjustedEnd ? " The end moved back because the last lines only lead into a quotation." : "");
  const tooShort = duration < limits.minMs;
  const aim = ` Keep the end where the point ends and start later, so the clip runs 30 to 60 seconds, or ${limits.cutMaxMs / 1000} at most`;
  const limit = tooShort
    ? ` A clip must be at least ${limits.minMs / 1000} seconds.`
    : duration > limits.maxMs
      ? ` A clip must not run past ${limits.maxMs / 1000} seconds.${aim} if the point needs it.`
      : ` The point runs past ${limits.maxMs / 1000} seconds, so this clip is part of it and must run ${limits.cutMaxMs / 1000} ` +
        `seconds at most.${aim}.`;
  const seconds = `${(duration / 1000).toFixed(1)} seconds`;
  const span =
    startUnit === choice.startUnit && endUnit === choice.endUnit
      ? `${asked} run ${seconds}.`
      : `${asked} become units [${startUnit}] to [${endUnit}] after the checks, ${seconds}.`;
  return tooShort ? { refused: `${span}${steps}${limit}` } : { refused: `${span}${steps}${limit}`, tooLongEnd: endUnit };
}

export type BoundaryTurn = { role: "user" | "assistant"; content: string };
type BoundaryAnswer = z.infer<typeof BoundaryChoiceSchema>;
type BoundaryAttempt = BoundaryAnswer & { refused: string | null; question?: string };

const QUESTION_END = /\?["”'’)\]]*$/;
const QUESTION_MIN_WORDS = 4;

/**
 * The question a clip would end on, when it is worth a second look: four words or more, so a call-out
 * like "Amen?" passes, and with lines after it to answer it.
 */
function endingQuestion(context: BoundaryContext, endUnit: number): string | null {
  if (endUnit >= context.units.length - 1) return null;
  const sentences = context.units[endUnit].text.split(/(?<=[.!?…]["”'’)\]]*)\s+/);
  const last = sentences[sentences.length - 1].trim();
  return QUESTION_END.test(last) && last.split(/\s+/).length >= QUESTION_MIN_WORDS ? last : null;
}

const REFUSED_TRIES = 3;

/**
 * Asks for a boundary and checks it.
 *
 * A refused answer gets up to two more tries with the reason (lab sermon 3 clip 5: the only answer
 * ran over 60 seconds, so the clip kept its raw window and ran past the punch line; fix I2 refuses
 * an end inside a list as well). After three refusals the range is null and the clip has no fixed
 * boundary. Once an answer runs too long, every later answer must keep its end, give or take
 * KEEP_END_SLACK_MS (fix K2), and run BOUNDARY_CUT_MAX_MS at most.
 *
 * An accepted answer that ends on a question gets one more look (lab sermon 1d clips 3 and 5, 2b
 * clip 6: each ended on a question the preacher answered or asked again in the next lines). The
 * model may keep the same end when a new idea starts next. An answer to that look which the code
 * refuses gets one more try with the reason (dry run, 2b clip 6: it kept going to the answer but ran
 * over 60 seconds); if that is refused too, the accepted answer stands. Five model calls at most.
 *
 * A second look at every end (fix I3) failed its gate on 2026-10-19: given the 24 clips of lab
 * sermons 1f, 2d, 3d and 4b as Jake saw them, it moved 11 of the 20 ends he did not fault and did
 * not fix 1f clip 1. Only the question gets a second look.
 */
export async function chooseBoundary(
  context: BoundaryContext,
  ask: (turns: BoundaryTurn[]) => Promise<BoundaryAnswer>,
  limits: BoundaryLimits = DEFAULT_LIMITS,
): Promise<{ range: BoundaryRange | null; attempts: BoundaryAttempt[] }> {
  const turns: BoundaryTurn[] = [{ role: "user", content: boundaryPrompt(context) }];
  const attempts: BoundaryAttempt[] = [];
  let heldEnd: number | null = null;
  const answerOnce = async () => {
    const answer = await ask([...turns]);
    const result = evaluateBoundaryChoice(context, answer, limits, heldEnd);
    if ("tooLongEnd" in result && result.tooLongEnd !== undefined) heldEnd = result.tooLongEnd;
    const record: BoundaryAttempt = {
      startUnit: answer.startUnit,
      endUnit: answer.endUnit,
      reason: answer.reason,
      refused: "refused" in result ? result.refused : null,
    };
    attempts.push(record);
    return { answer, result, record };
  };
  const reply = (answer: BoundaryAnswer, content: string) =>
    turns.push({ role: "assistant", content: JSON.stringify(answer) }, { role: "user", content });
  const refusal = (refused: string) =>
    `Your answer was refused: ${refused} Choose again from the same numbered sentences, following every rule. Return startUnit, endUnit and a one-sentence reason.`;

  let accepted = await answerOnce();
  for (let tries = 1; "refused" in accepted.result && tries < REFUSED_TRIES; tries += 1) {
    reply(accepted.answer, refusal(accepted.result.refused));
    accepted = await answerOnce();
  }
  const result = accepted.result;
  if ("refused" in result) return { range: null, attempts };
  const { range, endUnit } = result;

  const question = endingQuestion(context, endUnit);
  if (!question) return { range, attempts };
  accepted.record.question = question;
  reply(
    accepted.answer,
    `Unit [${endUnit}] ends on a question: "${question}" Read the lines after it. If the preacher answers it ` +
      `or asks it again, end after his answer, and keep the clip within ${limits.maxMs / 1000} seconds; start later if you must, but do ` +
      "not end before the question. If the next line starts a new idea, return the same end. Return startUnit, " +
      "endUnit and a one-sentence reason.",
  );
  const checked = await answerOnce();
  if ("range" in checked.result) return { range: checked.result.range, attempts };
  reply(checked.answer, refusal(checked.result.refused));
  const retry = await answerOnce();
  return { range: "range" in retry.result ? retry.result.range : range, attempts };
}
