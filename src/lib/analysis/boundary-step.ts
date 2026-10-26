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

// Fix O (lab sermon 5d clip 5, 2026-10-21): 'Jesus said, "Ask and you shall receive."' says the
// quotation; it does not lead into it. In 173 marked clips this check moved an end back 3 times, and
// all 3 failed. 'He says, "Your adversary the devil".' (1c clip 5) closes no sentence inside its quote.
const closesQuotedSentence = (text: string) => quoteBalance(text) === 0 && /[.!?]["”]/.test(text);

/**
 * True when a sentence only leads into a quotation — announcing it, or opening a quote that the
 * next sentence finishes — so a clip ending there stops before the words it promised. Lab sermon
 * 1c clip 5 ended on two such lines after Jake's chosen end, "Secondly, you need to resist him."
 */
export function endsOnQuotationStart(text: string): boolean {
  if (QUOTATION_LEADS.some((pattern) => pattern.test(text)) && !closesQuotedSentence(text)) return true;
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
// Fix W (lab sermon 5g, 2026-10-25): Scribe writes a "..." segment where a crowd word cuts into a
// sentence ("...the manifest presence- Yes" / "..." / "of our Lord and Savior, Jesus Christ."). Its
// dots are not a sentence end: the open sentence runs on through it.
const ELLIPSIS_ONLY = /^[.…\s]+$/;

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
    if (ELLIPSIS_ONLY.test(text)) {
      if (open !== null) {
        open.endMs = segment.endMs;
        open.text = `${open.text} ${text}`;
      }
      continue;
    }
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

// Fix W (lab sermon 5g clip 4, 2026-10-25): the clip ended on "Revival is an experience for God's
// people.", the second of two "Revival is" lines, with "It is a renewal …", "It is a spiritual
// awakening …" and four "In times of revival …" lines right after it. Jake: "I don't think he
// finished his point completely." Fix I2 needs three lines with the same opening, so none of these
// runs of two counted. Runs of two or more lines with the same opening two words (a leading "and",
// "but", "so" or "now" aside), with at most two other lines between the runs, are one block of
// parallel lines, when one run has three or more. The clip must not end on a line of the block
// before its last, nor on a call-out right after one. A full line between two runs is not a line of
// the block: 4b clip 1's "And everywhere God speaks, it is absolute truth." closes the "That's why"
// pair before the "What God says" list, and Jake's end is right after it. Over the 274 marked clips
// this rule fires on 2b clip 6 and 5g clip 4, both failed, and on no passed clip; chaining runs of
// two alone would also move 1f clip 5, which passed.
const BLOCK_FILLERS = new Set(["and", "but", "so", "now", "see", "well", "yeah", "amen", "listen", "oh", "then"]);
const BLOCK_CHAIN_STEP = LIST_MAX_STEP;

/** The opening two words of a line of five words or more, past any filler words; null otherwise. */
function blockOpening(words: string[]): string | null {
  let first = 0;
  while (first < words.length && BLOCK_FILLERS.has(words[first])) first += 1;
  return words.length - first >= LIST_ITEM_MIN_WORDS ? words.slice(first, first + 2).join(" ") : null;
}

/** The opening words as the preacher said them, for the refusal. */
function spokenOpening(text: string): string {
  const words = text.trim().split(/\s+/);
  let first = 0;
  while (first < words.length && BLOCK_FILLERS.has(words[first].toLowerCase().replace(/[^a-z]/g, ""))) first += 1;
  return words
    .slice(first, first + 2)
    .join(" ")
    .replace(/[^\p{L}\p{N}'’]+$/u, "");
}

/**
 * The block of parallel lines a clip would end inside: runs of two or more lines that open the same
 * way, chained when the next run starts within BLOCK_CHAIN_STEP lines of the last one's end, with at
 * least two runs and one of three or more lines. The end is inside when it is on a line of the block
 * before its last, or on a call-out right after one; a full line between two runs is not inside. Null when the end is on the block's last line, after it, or
 * before it.
 */
export function endsInsideParallelBlock(units: BoundaryUnit[], endUnit: number): { first: number; last: number; openings: string[] } | null {
  const keys = units.map((unit) => blockOpening(listWords(unit.text)));
  const runs: { key: string; items: number[] }[] = [];
  let i = 0;
  while (i < units.length) {
    const key = keys[i];
    if (!key) {
      i += 1;
      continue;
    }
    const items = [i];
    for (let j = i + 1; j < units.length && j - items[items.length - 1] <= LIST_MAX_STEP; j += 1) if (keys[j] === key) items.push(j);
    if (items.length >= 2) {
      runs.push({ key, items });
      i = items[items.length - 1] + 1;
    } else i += 1;
  }
  const blocks: { first: number; last: number; runs: typeof runs }[] = [];
  for (const run of runs) {
    const last = blocks[blocks.length - 1];
    if (last && run.items[0] - last.last <= BLOCK_CHAIN_STEP) {
      last.runs.push(run);
      last.last = run.items[run.items.length - 1];
    } else blocks.push({ first: run.items[0], last: run.items[run.items.length - 1], runs: [run] });
  }
  for (const block of blocks) {
    if (block.runs.length < 2 || !block.runs.some((run) => run.items.length >= LIST_MIN_ITEMS)) continue;
    if (endUnit < block.first || endUnit >= block.last) continue;
    const lines = new Set(block.runs.flatMap((run) => run.items));
    // A clip that ends on "Yeah." or "Amen." right after a line of the block ends on that line.
    let probe = endUnit;
    while (probe > block.first && !lines.has(probe) && listWords(units[probe].text).length < LIST_ITEM_MIN_WORDS) probe -= 1;
    if (lines.has(probe)) {
      return { first: block.first, last: block.last, openings: block.runs.map((run) => spokenOpening(units[run.items[0]].text)) };
    }
  }
  return null;
}

// Fix X (lab sermon 4i clip 6, 2026-10-25): the clip ended on 'He says there, "Yes, I think it is right
// as long as I am in this tent to stir you up by reminding you of this truth."', the verse 13 quote,
// with the preacher's application right after it. Jake: "he doesn't end with a powerful statement
// about the scripture he read, it's just the last verse. The clips should always start and end with
// a powerful statement / commentary." He passed 4d clip 4, the same verses with the application.
// The prompt already says never to stop right after a verse; the code now refuses it. A line reads a
// verse when it names a verse, chapter or book and quotes words, or quotes words right after a line
// that names one. Over the 274 marked clips, no passed clip ends on such a line; 4i clip 6 does.
const VERSE_REF = /\b(?:verses?|chapter)\s+\w+/i;
const BOOK_CHAPTER = new RegExp(`\\b(?:(?:first|second|third|1st|2nd|3rd|[123]|i{1,3})\\s+)?(?:${BOOKS})\\s+(?:\\d+|chapter)\\b`, "i");
const BIBLE_SAYS = /\b(?:the bible says|the word of god says|the scripture says|scripture says)\b/i;
const SAYS_THEN_QUOTE = /\b(?:says?|said|wrote|writes|reads?)\b[^"“]{0,25}["“]/i;
const QUOTED_WORDS = /["“][^"”]{12,}/;
const namesScripture = (text: string) => VERSE_REF.test(text) || BOOK_CHAPTER.test(text) || BIBLE_SAYS.test(text);
const quotesWords = (text: string) => SAYS_THEN_QUOTE.test(text) || QUOTED_WORDS.test(text) || /^\W*["“]/.test(text);

/** True when the line reads or quotes a verse: it names Scripture and quotes words, or quotes words right after a line that names Scripture. */
export function readsVerse(units: BoundaryUnit[], unit: number): boolean {
  const text = units[unit].text;
  if (namesScripture(text) && quotesWords(text)) return true;
  return unit > 0 && quotesWords(text) && namesScripture(units[unit - 1].text);
}

// Fix K1 (lab sermon 4c clips 5 and 6, 2026-10-20): "three things that are certain", then "First of
// all", and the clip ends. Jake: "it feels odd that he says here are three things and he only lists one."
const ANNOUNCED_COUNT =
  /\b(?:two|three|four|five|six|seven|[2-7])\s+(?:\w+\s+){0,2}?(?:things|ways|reasons|truths|certainties|points|keys|lessons|questions|steps|marks|facts|principles|kinds|types|areas|benefits|promises|blessings|secrets)\b/i;
const FIRST_ITEM = /\b(?:first of all|first(?:ly)?,|number one|the first (?:one|thing|is))/i;
const LATER_ITEM = /\b(?:second(?:ly)?|number two|third(?:ly)?|the next (?:one|thing)|another (?:one|thing)|finally|lastly)\b/i;

// Fix T (lab sermon 1n clip 2, 2026-10-23; the same clip failed in 1d and passed in 1g): the clip ended on
// "So God's grace gonna make you fit.", a recap of point one, right before "But number two, God's grace
// can make you firm." Jake: 'it would be better if it ended on, "Jesus can heal you today. Hallelujah."'
// Over the 244 marked clips, only this clip (3 marks) ends on a recap that leads into the next point.
const RECAP_OPENER = /^\W*(?:(?:and|now|well|yeah|amen|see)\W+)*(?:so|that'?s why|that is why)\b/i;
const NEXT_POINT = /\b(?:number (?:two|three|four|five|2|3|4|5)|(?:a|the) (?:second|third|fourth|next) (?:\w+ )?(?:thing|point|truth|certainty|reason|way|one))\b/i;
const NEXT_POINT_WORDS = 6;

/** True when the end line recaps the point ("So …") and the line after it opens the next numbered point. */
export function endsOnRecapIntoNextPoint(units: BoundaryUnit[], endUnit: number): boolean {
  const next = units[endUnit + 1];
  if (!next || !RECAP_OPENER.test(units[endUnit].text)) return false;
  const head = next.text.split(/\s+/).slice(0, NEXT_POINT_WORDS).join(" ");
  return LATER_ITEM.test(head) || NEXT_POINT.test(head);
}
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

export function boundaryPrompt(context: BoundaryContext, hold: HeldEnd | null = null): string {
  const lines = context.units.map((u, i) => `[${i}] (${clock(u.startMs)}) ${u.text}`);
  // Fix U: the story check found where the story lands, past 90 seconds from the clip's start.
  const holdTheEnd = hold
    ? `Hold the end: ${hold.why} Keep the end at unit [${hold.endUnit}], or within ${KEEP_END_SLACK_MS / 1000} seconds of it, and ` +
      `start later, so the clip runs ${BOUNDARY_CUT_MAX_MS / 1000} seconds at most and a viewer sees the story land.\n\n`
    : "";
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
    holdTheEnd +
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

/** An end the clip must keep, give or take KEEP_END_SLACK_MS, and the sentence that tells the model why. */
export type HeldEnd = { endUnit: number; why: string };

/**
 * `held` is the end unit of the latest answer refused as too long (fix K2), or the line where a story
 * lands (fix U); null before one. A refusal for length returns its end unit as `tooLongEnd`.
 */
function evaluateBoundaryChoice(
  context: BoundaryContext,
  choice: BoundaryChoice,
  limits: BoundaryLimits,
  held: HeldEnd | null,
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
  // Fix T: a "So …" recap of the point right before the next numbered point is not the ending either.
  while (endUnit > startUnit && endsOnRecapIntoNextPoint(units, endUnit)) {
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
  const block = endsInsideParallelBlock(units, endUnit);
  if (block) {
    return {
      refused:
        `${moved}Unit [${endUnit}] is inside a run of parallel lines: units [${block.first}] to [${block.last}] open with ` +
        `"${block.openings.join('", "')}", and the run goes on after it. End after its last line, unit [${block.last}], or before ` +
        `the run starts, at unit [${block.first - 1}] or earlier. Start later if you must to stay within ${limits.maxMs / 1000} seconds.`,
    };
  }
  if (readsVerse(units, endUnit)) {
    return {
      refused:
        `${moved}Unit [${endUnit}] reads the Scripture. Never end on the reading: end after it, on the line where the preacher ` +
        `says what it means, or before the reading starts. Start later if you must to stay within ${limits.maxMs / 1000} seconds.`,
    };
  }

  if (held !== null && units[endUnit].endMs < units[held.endUnit].endMs - KEEP_END_SLACK_MS) {
    const sooner = ((units[held.endUnit].endMs - units[endUnit].endMs) / 1000).toFixed(1);
    return {
      refused:
        `${moved}${held.why} This answer ends at unit [${endUnit}], ${sooner} seconds sooner, which cuts the point short. Keep the ` +
        `end at unit [${held.endUnit}] or later, and start later.`,
    };
  }

  const startMs = units[startUnit].startMs;
  const endMs = units[endUnit].endMs;
  const duration = endMs - startMs;
  const maxMs = held === null ? limits.maxMs : Math.min(limits.maxMs, limits.cutMaxMs);
  if (duration >= limits.minMs && duration <= maxMs) {
    return { range: { startMs, endMs, adjustedForScripture, adjustedEnd }, endUnit };
  }
  const steps =
    (adjustedForScripture ? " The start moved past the Scripture reading." : "") +
    (adjustedEnd ? " The end moved back because the last lines only lead into a quotation, or recap the point before the next one." : "");
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
  hold: HeldEnd | null = null,
): Promise<{ range: BoundaryRange | null; attempts: BoundaryAttempt[] }> {
  const turns: BoundaryTurn[] = [{ role: "user", content: boundaryPrompt(context, hold) }];
  const attempts: BoundaryAttempt[] = [];
  let held: HeldEnd | null = hold;
  const answerOnce = async () => {
    const answer = await ask([...turns]);
    const result = evaluateBoundaryChoice(context, answer, limits, held);
    if ("tooLongEnd" in result && result.tooLongEnd !== undefined) {
      const unit = result.tooLongEnd;
      held = {
        endUnit: unit,
        why: `Your last answer that ran too long ended at unit [${unit}] (${clock(context.units[unit].startMs)}), where the point ends.`,
      };
    }
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

/**
 * Fix M, one look past the end (lab sermons 1j clip 4 and 5b clip 3, 2026-10-20): both clips ended one
 * beat before the preacher finished the point. 1j clip 4 ended on "If you're a friend of Jesus Christ,
 * you've got an enemy."; Jake: "It should end with, " Amen. He is the devil."" No pause, word or
 * pattern marks these ends (of 53 marked clips with under 0.3 s after the end, 35 passed), so one model
 * call reads the clip and the lines that end within 6 seconds after it. The end moves later only, to
 * the first line that finishes the point. Prototype, two runs on the 83 clips Jake marked in three
 * rounds: 3 of 9 failed ends fixed, 0 of 66 passed ends moved. A looser prompt fixed 5 and moved 9.
 *
 * Fix R (lab sermon 3i clip 4, 2026-10-22): when the look finds that the last line sets up lines the
 * code then refuses as the new end, the last line is dropped and the clip ends on the line before. 3d
 * clip 5, 3h clip 6 and 3i clip 4 all ended on 'you're not gonna say, "Man, I just spent too much time
 * down there at the church."'; the look chose "I should've watched ESPN more.", inside a list, so the
 * set-up stood. Jake failed all three ("the preacher didn't finish his statement") and passed 3b clip 2
 * and 3e clip 4, which end on the line before. In 90 looks over two marked rounds, only these two were
 * refused for a reason other than a bad line number.
 *
 * Fix X (2026-10-25) tried a window counted from the next line's start: 4i clip 6's application line
 * ran 6.8 seconds and ended 8.1 seconds after the cut, so the look was never asked. Over the 274
 * marked clips it re-asked the look on 142 to 176 clips and moved 6 to 8 passed ones, while asking
 * the old window again moved 4 passed ones from model variance alone, and it fixed no failed clip
 * the old window did not. The window stays as it is; fix X's verse rule moves that clip instead.
 */
export const END_LOOK_MAX_MS = 6_000;
const END_LOOK_LINES = 5;

export const EndLookSchema = z.object({ finishesLater: z.boolean(), endUnit: z.number().int(), reason: z.string() });
export type EndLookAnswer = z.infer<typeof EndLookSchema>;
export type EndLook = {
  asked: boolean;
  movedMs: number;
  refused: string | null;
  reason?: string;
  added?: string;
  /** Fix R: the set-up lines taken off the end. */
  dropped?: string;
};

/** The clip's sentences and up to five that end within 6 seconds after it, numbered from the clip's start; null when none do. */
export function endLookLines(
  units: BoundaryUnit[],
  range: { startMs: number; endMs: number },
): { lines: BoundaryUnit[]; end: number; last: number; offset: number } | null {
  const start = units.findIndex((u) => u.endMs > range.startMs);
  if (start < 0) return null;
  let end = units.length - 1;
  while (end > start && units[end].startMs >= range.endMs) end -= 1;
  let last = end;
  while (last + 1 < units.length && last - end < END_LOOK_LINES && units[last + 1].endMs - units[end].endMs <= END_LOOK_MAX_MS) last += 1;
  return last === end ? null : { lines: units.slice(start, last + 1), end: end - start, last: last - start, offset: start };
}

export function endLookPrompt(lines: BoundaryUnit[], end: number, last: number): string {
  // Neutral examples only: the gate on Jake's clips is fair only when the prompt holds none of them.
  return (
    "Below are the numbered sentences of a short sermon clip, with their times, and the sentences that come right after it. " +
    `The clip ends on [${end}]. Lines after [${end}] are not in the clip yet.\n\n` +
    "Decide one thing: does the clip stop one beat before the preacher finishes this point? That is true only when the " +
    `last line [${end}] sets something up that the very next lines complete: he answers the question he just asked, names ` +
    "what he just described, says the line his build-up was leading to, or in one more line turns the same point into what " +
    "it means for the listener. Examples: \"There is one thing God cannot do.\" then \"He cannot lie.\"; \"You don't have to " +
    "carry that guilt.\" then \"Amen. Jesus already carried it for you.\" The finishing line may come after a short " +
    "\"Amen.\" or \"Yeah.\".\n" +
    `Keep the end when [${end}] already lands the point: a punch line, a charge or command (\"Be sober, be vigilant.\"), or a ` +
    "summary. Keep it also when the next line is a question to the crowd (\"is it not?\"), a crowd response with nothing " +
    "after it, the next item of a list, a Scripture reading, or a turn to a new thought (\"But…\", \"Now…\"). Most clips " +
    "already end in the right place.\n" +
    `If it is true, return the FIRST line that finishes the point, one of [${end + 1}] to [${last}], and nothing after it.\n\n` +
    "Return finishesLater, endUnit (the same end when finishesLater is false) and a one-sentence reason.\n\n" +
    lines.map((u, i) => `[${i}] (${clock(u.startMs)}) ${u.text}`).join("\n")
  );
}

/**
 * One look past an accepted end. The code keeps the end unless the answer is a later line it showed,
 * not a quotation lead-in, not inside a list, and the clip stays within `maxMs`. When the answer is a
 * line it showed but refuses on those grounds, the clip drops its last line instead (fix R), if the
 * shorter clip passes the boundary step's checks and does not end on a question.
 */
export async function lookPastTheEnd(
  units: BoundaryUnit[],
  range: { startMs: number; endMs: number },
  ask: (prompt: string) => Promise<EndLookAnswer>,
  maxMs = BOUNDARY_MAX_MS,
): Promise<{ range: { startMs: number; endMs: number }; look: EndLook }> {
  const look = endLookLines(units, range);
  if (!look) return { range, look: { asked: false, movedMs: 0, refused: null } };
  const answer = await ask(endLookPrompt(look.lines, look.end, look.last));
  const kept = (refused: string | null) => ({ range, look: { asked: true, movedMs: 0, refused, reason: answer.reason } });
  if (!answer.finishesLater) return kept(null);
  if (!Number.isInteger(answer.endUnit) || answer.endUnit <= look.end || answer.endUnit > look.last) {
    return kept(`Unit [${answer.endUnit}] is not one of the lines after the end, [${look.end + 1}] to [${look.last}].`);
  }
  const withoutSetUp = (refused: string) => {
    const lastUnit = look.offset + look.end;
    const context = { units, currentStart: look.offset, currentEnd: lastUnit - 1 };
    const shorter =
      lastUnit > look.offset
        ? evaluateBoundaryChoice(context, { startUnit: look.offset, endUnit: lastUnit - 1 }, { ...DEFAULT_LIMITS, maxMs }, null)
        : null;
    if (!shorter || !("range" in shorter) || shorter.range.startMs !== range.startMs || endingQuestion(context, shorter.endUnit)) {
      return kept(refused);
    }
    return {
      range: { startMs: range.startMs, endMs: shorter.range.endMs },
      look: {
        asked: true,
        movedMs: shorter.range.endMs - range.endMs,
        refused,
        reason: answer.reason,
        dropped: units.slice(shorter.endUnit + 1, lastUnit + 1).map((u) => u.text).join(" "),
      },
    };
  };
  const unit = look.offset + answer.endUnit;
  // Fix X: the point lands where the preacher says what the verse means, not on the verse. Checked
  // first: a verse the model picks is not a sign that the clip's last line was a set-up (fix R).
  if (readsVerse(units, unit)) return kept(`Unit [${answer.endUnit}] reads the Scripture; the point lands where the preacher says what it means.`);
  if (endsOnQuotationStart(units[unit].text)) return withoutSetUp(`Unit [${answer.endUnit}] only leads into a quotation.`);
  if (endsInsideList(units, unit)) return withoutSetUp(`Unit [${answer.endUnit}] is inside a list.`);
  if (endsInsideParallelBlock(units, unit)) return withoutSetUp(`Unit [${answer.endUnit}] is inside a run of parallel lines.`);
  // Fix T: the recap before the next numbered point is not where the point lands.
  if (endsOnRecapIntoNextPoint(units, unit)) return kept(`Unit [${answer.endUnit}] recaps the point and leads into the next numbered point.`);
  if (units[unit].endMs - range.startMs > maxMs) {
    return withoutSetUp(`Ending on unit [${answer.endUnit}] makes the clip run past ${maxMs / 1000} seconds.`);
  }
  return {
    range: { startMs: range.startMs, endMs: units[unit].endMs },
    look: {
      asked: true,
      movedMs: units[unit].endMs - range.endMs,
      refused: null,
      reason: answer.reason,
      added: look.lines.slice(look.end + 1, answer.endUnit + 1).map((u) => u.text).join(" "),
    },
  };
}

/**
 * Fix U, the story check (lab sermon 1n clip 6, 2026-10-23). The clip ended as Jesus knelt and washed
 * the disciples' feet; Peter's objection, Jesus's reply and the meaning came 75 seconds later. Jake:
 * "It stops in the middle of the story." The boundary step called the description a landed point, and
 * the end look saw only "Amen." in its 6 seconds. This story was marked 10 times over the rounds and
 * passed clean once: 1l clip 1, from Peter's objection to "wash our feet", 73 seconds.
 *
 * One model call reads the clip and up to 25 sentences that start within 90 seconds after it, and
 * says whether the clip is cut from the middle of one story, dialogue or argument, and where its point
 * lands. When the landing line keeps the clip within 90 seconds, the end moves there. When it does
 * not, the boundary step runs again with that end held (fix K2's rule) so the clip starts later.
 */
export const STORY_LOOK_MAX_MS = 90_000;
const STORY_LOOK_LINES = 25;

export const StoryCheckSchema = z.object({
  /** The model's own reading of the clip's last line; code keeps the range unless it is narration. */
  endIsNarration: z.boolean(),
  /** What the clip tells; code goes on only for a story of events. */
  storyKind: z.enum(["events", "list", "teaching", "verse", "none"]),
  /** The first line of the clip that narrates the story, -1 when none; code needs 12 seconds of story in the clip. */
  storyStartsUnit: z.number().int(),
  /** The line inside the clip where the preacher states his point about the story, -1 when none; code keeps such a clip. */
  pointStatedUnit: z.number().int(),
  continues: z.boolean(),
  landsUnit: z.number().int(),
  reason: z.string(),
});
// Gate run over 244 marked clips, 2026-10-24: without this, the check restarted lab sermon 2d clip 5 and
// extended 2b, 2d, 2e and 2f clip 5 (all passed), where Saul's story began on the clip's last line after
// the point had landed. A story the clip only introduces belongs to the next clip.
export const STORY_MIN_IN_CLIP_MS = 12_000;
export type StoryCheckAnswer = z.infer<typeof StoryCheckSchema>;
export type StoryCheck = {
  asked: boolean;
  continues: boolean;
  /** Where the model says the story lands, on the source clock; null when it did not say. */
  landsMs: number | null;
  refused: string | null;
  reason?: string;
  /** The second look's reason, when the first said the story continues. */
  secondReason?: string;
  /** How the range changed: the end moved to the landing line, or the clip kept that end and started later. */
  outcome?: "extended" | "restarted" | "unresolved";
  movedMs?: number;
};

/** The clip's sentences and up to 25 that start within 90 seconds after it, numbered from the clip's start; null when none do. */
export function storyLookLines(
  units: BoundaryUnit[],
  range: { startMs: number; endMs: number },
): { lines: BoundaryUnit[]; end: number; last: number; offset: number } | null {
  const start = units.findIndex((u) => u.endMs > range.startMs);
  if (start < 0) return null;
  let end = units.length - 1;
  while (end > start && units[end].startMs >= range.endMs) end -= 1;
  let last = end;
  while (last + 1 < units.length && last - end < STORY_LOOK_LINES && units[last + 1].startMs - units[end].endMs <= STORY_LOOK_MAX_MS) last += 1;
  return last === end ? null : { lines: units.slice(start, last + 1), end: end - start, last: last - start, offset: start };
}

export function storyPrompt(lines: BoundaryUnit[], end: number, last: number): string {
  // Neutral example only: the gate on Jake's clips is fair only when the prompt holds none of them.
  return (
    "Below are the numbered sentences of a short sermon clip, with their times, and up to 25 sentences that start within " +
    `90 seconds after it. The clip ends on [${end}]. Lines after [${end}] are not in the clip.\n\n` +
    "Decide one thing: is this clip cut out of the middle of a story the preacher is telling, so that a viewer never hears " +
    `how it ends? A story means narration: people, events, and quoted dialogue, told in order. First say whether line [${end}] ` +
    "itself is narration or dialogue of a story (endIsNarration). When it is not, the clip is complete and continues is false. " +
    `Say the story continues only when line [${end}] is narration or dialogue of that story, with no point drawn yet, and the ` +
    `lines after [${end}] keep telling the same story to its ending, its reply, or the sentence that says what it means. Example: a clip ends as the ` +
    "prodigal son leaves home with his money. The famine, his return and the father's welcome come after, so the story " +
    "continues, and it lands on the father's welcome.\n" +
    `The clip is complete when [${end}] is the preacher speaking to the listener: a point, a charge, a command, a question he ` +
    "puts to the crowd, an application or a summary. It is complete when the story inside it has been told, even when he goes " +
    "on talking about it. It is complete when the clip already states the preacher's point about the story, what it means for " +
    "the listener, even though the story goes on after it. It is complete when the lines after it begin a new story, example " +
    "or point (\"Now…\", \"But number two…\"), read a verse, or are a crowd response. One more line that answers a question or " +
    "finishes a thought is not a story continuing; say complete. A list, a chain of reasoning, a verse he reads and explains, " +
    "or the preacher saying what a Bible writer teaches is not a story. Most clips are complete.\n" +
    "Also return storyKind: \"events\" when the clip tells people and happenings in order, \"list\" for a list or a run of " +
    "parallel lines, \"teaching\" for explanation or reasoning, \"verse\" for a verse he reads and explains, \"none\" for no story. " +
    `Return storyStartsUnit: the first line of the clip, [0] to [${end}], that narrates the story, or -1 when none does. Return ` +
    `pointStatedUnit: the line inside the clip, [0] to [${end}], where the preacher states his point about the story, what it ` +
    "means for the listener, or -1 when the clip holds no such line.\n" +
    "If the story continues, return the FIRST line after which the story and its meaning have landed: the sentence that " +
    `says what it means or applies it, or, when he draws no meaning within these lines, its last event, one of [${end + 1}] to ` +
    `[${last}]. Stop there; do not go on to a verse he reads after it or to a new point. If it does not land within these ` +
    "lines, return landsUnit -1.\n\n" +
    "Return endIsNarration, storyKind, storyStartsUnit, pointStatedUnit, continues, landsUnit (-1 when continues is false) and a " +
    "one-sentence reason.\n\n" +
    lines.map((u, i) => `[${i}] (${clock(u.startMs)}) ${u.text}`).join("\n")
  );
}

// A crowd or preacher response the check skips when it reads the line after the clip.
const RESPONSE_LINE = /^\W*(?:(?:amen|yeah|yes|hallelujah|good|right|wow|that's right|yes,? sir|come on)[.!?,]*\s*)+$/i;
// "Look at what the Bible says in verse three." / "Notice verse four."
const VERSE_LEAD = /\b(?:look|notice|listen|read|see|watch)\b[^.?!]*\b(?:verse|chapter)\s+\w+/i;

/** True when the first line after the clip, past any short response, announces or reads a verse. */
export function readsVerseNext(units: BoundaryUnit[], endUnit: number): boolean {
  let i = endUnit + 1;
  while (i < units.length && i <= endUnit + 2 && RESPONSE_LINE.test(units[i].text)) i += 1;
  const next = units[i];
  if (!next) return false;
  return looksLikeScriptureReadingStart(next.text) || VERSE_LEAD.test(next.text);
}

/**
 * One story check on an accepted range, asked twice. Gate runs over the 244 marked clips, 2026-10-24: a
 * clip the check moved in one run and not the next (lab sermons 2j clip 1, 5f clip 5, 2d clip 5, all
 * passed) was a borderline reading, while every clip Jake failed for a cut-off story moved in all three
 * runs. So the second look, made only when the first says the story continues, must agree.
 *
 * The end moves to the landing line when the code accepts that choice (whole sentences, not inside a
 * list, within `limits.maxMs`). When the landing line makes the clip too long, the boundary step runs
 * again with that end held, and the clip starts later. Any other refusal keeps the range as it was.
 */
export async function checkStory(
  context: BoundaryContext,
  range: { startMs: number; endMs: number },
  askStory: (prompt: string) => Promise<StoryCheckAnswer>,
  askBoundary: (turns: BoundaryTurn[]) => Promise<BoundaryAnswer>,
  limits: BoundaryLimits = DEFAULT_LIMITS,
): Promise<{ range: { startMs: number; endMs: number }; check: StoryCheck; attempts?: BoundaryAttempt[] }> {
  const { units } = context;
  const look = storyLookLines(units, range);
  if (!look) return { range, check: { asked: false, continues: false, landsMs: null, refused: null } };
  // Gate run, 2026-10-24: lab sermon 2b clip 5 (passed four times) ends Saul's story on "he has an
  // encounter with Jesus Christ. Amen." and the preacher then reads verse three. The reading is the
  // next clip's business, so no call is made.
  if (readsVerseNext(units, look.offset + look.end)) {
    return { range, check: { asked: false, continues: false, landsMs: null, refused: "The lines after the clip read a verse." } };
  }

  /** Why the code stops at this answer; "" when the answer says the clip is complete; null when the story continues. */
  const gate = (a: StoryCheckAnswer): string | null => {
    // The model's own reading of the last line gates its answer: a point, charge or question is complete.
    if (!a.endIsNarration || !a.continues) return "";
    // Gate run, 2026-10-24: a recounting of Paul's blessings in Ephesians (lab sermon 5e clip 4, passed) is
    // not a story, and the Transfiguration clip (4g clip 5, passed) states its point before the narration.
    if (a.storyKind !== "events") return `What the clip tells is ${a.storyKind === "none" ? "not a story" : `a ${a.storyKind}, not a story of events`}.`;
    if (Number.isInteger(a.pointStatedUnit) && a.pointStatedUnit >= 0 && a.pointStatedUnit <= look.end) {
      return `The clip states the preacher's point about the story at [${a.pointStatedUnit}].`;
    }
    // A story the clip only introduces in its last seconds belongs to the next clip.
    const storyStart =
      Number.isInteger(a.storyStartsUnit) && a.storyStartsUnit >= 0 && a.storyStartsUnit <= look.end ? units[look.offset + a.storyStartsUnit] : null;
    if (!storyStart || units[look.offset + look.end].endMs - storyStart.startMs < STORY_MIN_IN_CLIP_MS) {
      return `The story fills less than ${STORY_MIN_IN_CLIP_MS / 1000} seconds of the clip, so the clip's point is not the story.`;
    }
    if (a.landsUnit === -1) return "The story does not land within the lines shown.";
    if (!Number.isInteger(a.landsUnit) || a.landsUnit <= look.end || a.landsUnit > look.last) {
      return `Unit [${a.landsUnit}] is not one of the lines after the end, [${look.end + 1}] to [${look.last}].`;
    }
    return null;
  };

  const prompt = storyPrompt(look.lines, look.end, look.last);
  const answer = await askStory(prompt);
  const kept = (refused: string | null, extra: Partial<StoryCheck> = {}) => ({
    range,
    check: { asked: true, continues: answer.continues, landsMs: null, refused, reason: answer.reason, ...extra },
  });
  const stop = gate(answer);
  if (stop !== null) return kept(stop === "" ? null : stop, answer.landsUnit === -1 && answer.continues ? { outcome: "unresolved" } : {});

  const second = await askStory(prompt);
  const stopSecond = gate(second);
  if (stopSecond !== null) {
    return kept(`A second look did not agree that the story continues.${stopSecond ? ` It said: ${stopSecond}` : ""}`, { secondReason: second.reason });
  }
  // Two landings: the later one, so the meaning the preacher draws is not left out, but never a verse he
  // reads after the story (gate run 4: one look landed the foot-washing story on John 13:14 itself).
  const isVerse = (u: number) =>
    looksLikeScriptureReadingStart(units[u].text) || (u > 0 && (looksLikeScriptureReadingStart(units[u - 1].text) || VERSE_LEAD.test(units[u - 1].text)));
  const landings = [...new Set([answer.landsUnit, second.landsUnit])].map((l) => look.offset + l).filter((u) => !isVerse(u));
  if (landings.length === 0) return kept("The landing is a verse he reads after the story.", { secondReason: second.reason });
  const unit = Math.max(...landings);
  const landsMs = units[unit].endMs;
  const extended = evaluateBoundaryChoice(context, { startUnit: look.offset, endUnit: unit }, limits, null);
  if ("range" in extended) {
    if (extended.range.startMs !== range.startMs) return kept("The start moved.", { landsMs });
    return {
      range: { startMs: range.startMs, endMs: extended.range.endMs },
      check: {
        asked: true,
        continues: true,
        landsMs,
        refused: null,
        reason: answer.reason,
        secondReason: second.reason,
        outcome: "extended",
        movedMs: extended.range.endMs - range.endMs,
      },
    };
  }
  if (!("tooLongEnd" in extended) || extended.tooLongEnd === undefined) return kept(extended.refused, { landsMs });

  // Past 90 seconds: keep the landing and start later.
  const hold: HeldEnd = {
    endUnit: extended.tooLongEnd,
    why: `The story this clip is inside lands at unit [${extended.tooLongEnd}] (${clock(units[extended.tooLongEnd].startMs)}): "${units[extended.tooLongEnd].text}"`,
  };
  const restarted = await chooseBoundary(context, askBoundary, limits, hold);
  if (!restarted.range) {
    return {
      ...kept(`No later start was accepted: ${restarted.attempts.at(-1)?.refused ?? "no answer"}`, { landsMs, outcome: "unresolved" }),
      attempts: restarted.attempts,
    };
  }
  return {
    range: { startMs: restarted.range.startMs, endMs: restarted.range.endMs },
    check: {
      asked: true,
      continues: true,
      landsMs,
      refused: null,
      reason: answer.reason,
      secondReason: second.reason,
      outcome: "restarted",
      movedMs: restarted.range.endMs - range.endMs,
    },
    attempts: restarted.attempts,
  };
}
