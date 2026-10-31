import { captionLineId, type CaptionLine, type CaptionWord } from "./caption-lines";

/**
 * Phrase captions: one whole phrase per line (the phraseCaptions selection step, EXPORT_PHRASE_CAPTIONS_ENABLED).
 *
 * Jake, Codex session 2026-10-06: "Do you notice how i want the caption lines segments to be well
 * represented of an actually thought / phrase and not split in half? Correct Example: "not to
 * guess about him" Incorrect Example: 1st segment > "not to guess about" 2nd segment > "him, but
 * to know him"." He and Codex then corrected two recordings line by line (16 lines, kept as the
 * answer key in tests/phrase-caption-lines.test.ts). `buildCaptionLines` fills five words and
 * breaks, so it splits phrases in half and leaves "you." or "him," on a line of their own.
 *
 * The rules:
 * - A line breaks at the end of a sentence, at a comma, or at a pause of 0.7 s or more.
 * - A part of one word joins its neighbour, so "Therefore," and "Yes," do not stand alone; a
 *   sentence of one word ("Amen.") does.
 * - A part longer than seven words or 40 characters is split where the phrases allow: before a
 *   word that starts a phrase ("and", "that", "to", "the"), never after a word that leads into one,
 *   and never before an object such as "him". The fewest, most even lines win.
 * - A line shows when its first word starts and stays until the next line starts; after a pause of
 *   1 s or more it ends 0.3 s after its last word.
 * - A comma or period that ends a line is dropped; a question mark stays. (Since 2026-10-19 the
 *   render drops all punctuation and shows capital letters: Jake, "make subtitles full caps right
 *   now, no punctuation, and slighly larger font.")
 */

export const PHRASE_MAX_WORDS = 7;
// "Slightly larger": the Clean preset's 44 px becomes 48. On the lab sermons, 7 of 8,718 lines in
// capital letters are then wider than the row and wrap; at 50 px, 58 do.
export const PHRASE_CAPTION_SIZE_SCALE = 1.1;
export const PHRASE_MAX_CHARS = 40;
const PHRASE_MIN_WORDS = 2;
const PAUSE_BREAK_MS = 700;
const PAUSE_BONUS_MS = 250;
const HOLD_MAX_GAP_MS = 1_000;
const HOLD_AFTER_MS = 300;
// Each extra line costs this much, so a phrase is split only where its breaks are worth it.
const LINE_COST = 3;
const IDEAL_WORDS = 5;

const SENTENCE_END = /[.!?…]["”'’)\]]*$/;
const CLAUSE_END = /[,;:]["”'’)\]]*$/;
const LINE_END_PUNCTUATION = /[,;:.…]+(["”'’)\]]*)$/;

const STARTS_CLAUSE = ["and", "but", "or", "nor", "so", "yet", "because", "that", "which", "who", "whom", "whose", "when",
  "where", "while", "if", "unless", "until", "since", "though", "although", "then", "whether", "what", "how", "why", "cause", "'cause"];
const STARTS_PHRASE = ["to", "through", "into", "onto", "with", "without", "within", "from", "in", "on", "at", "by", "for",
  "about", "over", "under", "after", "before", "between", "among", "against", "around", "across", "toward", "towards",
  "upon", "unto", "like", "as"];
// A noun phrase often follows its verb ("puts His finger"), so a break before one weighs a little less.
const STARTS_NOUN = ["the", "a", "an", "this", "these", "those", "his", "her", "my", "your", "our", "their", "its", "every",
  "each", "some", "any", "all"];
const STARTS_WEAKLY = ["of", "i", "you", "he", "she", "we", "they", "it", "there"];
// A line never ends on one of these: each leads into the words after it. "this", "that" and "her"
// can close a phrase as well ("doing this", "restore her"), so they are left out.
const LEADS = new Set([
  ...STARTS_CLAUSE.filter((word) => word !== "that"),
  ...STARTS_PHRASE,
  ...STARTS_NOUN.filter((word) => !["this", "these", "those", "her"].includes(word)),
  "of", "not", "i", "he", "she", "we", "they",
  "am", "is", "are", "was", "were", "be", "been", "being", "will", "would", "can", "could", "shall", "should", "may",
  "might", "must", "do", "does", "did", "have", "has", "had", "gonna", "wanna", "gotta",
]);
// A line never starts on one of these: each closes the phrase before it ("guess about him").
const CLOSES = new Set(["him", "them", "me", "us", "himself", "herself", "themselves", "myself", "yourself", "yourselves",
  "ourselves"]);

const bare = (word: CaptionWord) =>
  word.word.toLowerCase().replace(/’/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
// "he's", "you're", "God's", "he'll": a contraction or possessive leads into the next word. A comma
// after such a word is a stammer ("the raise at, at your job"), not the end of a phrase.
const leads = (word: CaptionWord) =>
  !SENTENCE_END.test(word.word) && (LEADS.has(bare(word)) || /'(s|re|m|ll|ve|d)$/.test(bare(word)));

function breakWeight(word: CaptionWord, previous: CaptionWord): number {
  const text = bare(word);
  const weight = STARTS_CLAUSE.includes(text)
    ? 3
    : STARTS_PHRASE.includes(text)
      ? 2
      : STARTS_NOUN.includes(text)
        ? 1.5
        : STARTS_WEAKLY.includes(text)
          ? 1
          : 0;
  return weight + (word.startMs - previous.endMs >= PAUSE_BONUS_MS ? 1 : 0);
}

const joined = (words: CaptionWord[]) => words.map((word) => word.word).join(" ");
const fits = (words: CaptionWord[]) => words.length <= PHRASE_MAX_WORDS && joined(words).length <= PHRASE_MAX_CHARS;

/** Sentences, then commas and long pauses inside them; a one-word part joins its neighbour. */
function parts(words: CaptionWord[]): CaptionWord[][] {
  const sentences: CaptionWord[][] = [[]];
  for (const word of words) {
    sentences[sentences.length - 1].push(word);
    if (SENTENCE_END.test(word.word)) sentences.push([]);
  }
  return sentences
    .filter((sentence) => sentence.length > 0)
    .flatMap((sentence) => {
      const pieces: CaptionWord[][] = [[]];
      sentence.forEach((word, index) => {
        pieces[pieces.length - 1].push(word);
        const next = sentence[index + 1];
        if (!next) return;
        const pause = next.startMs - word.endMs >= PAUSE_BREAK_MS && !leads(word) && !CLOSES.has(bare(next));
        if ((CLAUSE_END.test(word.word) && !leads(word)) || pause) pieces.push([]);
      });
      for (let index = 0; index < pieces.length; index += 1) {
        if (pieces.length > 1 && pieces[index].length === 1) {
          if (index < pieces.length - 1) pieces[index + 1].unshift(...pieces[index]);
          else pieces[index - 1].push(...pieces[index]);
          pieces.splice(index, 1);
          index -= 1;
        }
      }
      return pieces;
    });
}

/** Splits a part that does not fit into the cheapest run of lines of 2 to 7 words. */
function split(words: CaptionWord[]): CaptionWord[][] {
  if (fits(words) || words.length < PHRASE_MIN_WORDS * 2) return [words];
  const n = words.length;
  const best: { cost: number; from: number }[] = [{ cost: 0, from: -1 }];
  for (let end = 1; end <= n; end += 1) {
    best[end] = { cost: Infinity, from: -1 };
    for (let start = Math.max(0, end - PHRASE_MAX_WORDS); start <= end - PHRASE_MIN_WORDS; start += 1) {
      if (best[start].cost === Infinity) continue;
      const line = words.slice(start, end);
      let cost = best[start].cost + LINE_COST + 0.25 * (line.length - IDEAL_WORDS) ** 2;
      if (!fits(line)) cost += 10;
      if (end < n) {
        const next = words[end];
        cost -= breakWeight(next, words[end - 1]);
        if (leads(words[end - 1]) || CLOSES.has(bare(next))) cost += 100;
      }
      if (cost < best[end].cost) best[end] = { cost, from: start };
    }
  }
  if (best[n].cost === Infinity) return [words];
  const lines: CaptionWord[][] = [];
  for (let end = n; end > 0; end = best[end].from) lines.unshift(words.slice(best[end].from, end));
  return lines;
}

export function buildPhraseCaptionLines(words: CaptionWord[], options: { endLimitMs?: number } = {}): CaptionLine[] {
  const groups = parts(words).flatMap(split);
  return groups.map((group, index) => {
    const startMs = group[0].startMs;
    const lastEnd = group[group.length - 1].endMs;
    const next = groups[index + 1]?.[0].startMs;
    let endMs = next !== undefined && next - lastEnd < HOLD_MAX_GAP_MS ? next : lastEnd + HOLD_AFTER_MS;
    if (next !== undefined) endMs = Math.min(endMs, next);
    if (options.endLimitMs !== undefined) endMs = Math.min(endMs, options.endLimitMs);
    return {
      id: captionLineId(group),
      startMs,
      endMs: Math.max(startMs, endMs),
      words: group,
      text: joined(group).replace(LINE_END_PUNCTUATION, "$1"),
    };
  });
}
