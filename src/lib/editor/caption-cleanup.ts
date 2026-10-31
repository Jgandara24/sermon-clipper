import type { CaptionWord } from "./caption-lines";

/**
 * Caption cleanup, before phrase grouping (the phraseCaptions selection step, EXPORT_PHRASE_CAPTIONS_ENABLED).
 * Jake, 2026-10-18:
 * 1. "Sometimes a background audience or congregation words will get transcribed. Ex: somone might
 *    shout, "Amen", and it get's transcribed. We don't want that."
 * 2. "If the speaker stutters, like, ", I, I, I, I married my high school sweetheart." please just
 *    transcribe "I" once."
 * Both change only what the captions show; the audio and the transcript are untouched.
 */

/**
 * A response sentence this many dB below the clip's median word is the congregation. Measured on lab
 * sermons 1e, 2c and 3c: the congregation's "Amen." sits 15 to 55 dB below the preacher's median
 * word, his own "Amen?" 0 to 7 dB below. Scribe labels both as the preacher, so its speaker labels
 * cannot tell them apart.
 */
export const CONGREGATION_QUIET_DB = 12;

/** Words a congregation calls out. A sentence made only of these can be a response. */
const RESPONSE_WORDS = new Set([
  "amen", "yeah", "yes", "yep", "sir", "ma'am", "preach", "preacher", "right", "that's", "come", "on", "hallelujah",
  "glory", "praise", "the", "lord", "god", "jesus", "well", "mm", "mm-hmm", "mhm", "uh-huh", "hmm", "oh", "wow", "go",
  "ahead", "say", "it", "true", "thank", "you", "so", "good", "help", "him", "uh", "um",
]);

/** Short words a preacher stammers on. A repeat of one of these, marked by a comma, is a stammer. */
const STAMMER_WORDS = new Set([
  "i", "you", "he", "she", "we", "they", "it", "me", "him", "them", "us", "the", "a", "an", "this", "that", "these",
  "those", "my", "your", "his", "her", "our", "their", "its", "and", "but", "or", "so", "if", "when", "what", "where",
  "who", "how", "why", "because", "to", "of", "in", "on", "at", "for", "with", "from", "about", "as", "like", "is",
  "was", "are", "were", "be", "will", "would", "can", "could", "do", "did", "have", "has", "had", "am", "gonna",
  "wanna", "just", "i'm", "you're", "he's", "she's", "it's", "we're", "they're", "that's", "there's", "what's", "i'll",
  "you'll", "he'll", "we'll", "i've", "we've", "don't", "can't", "won't", "didn't",
]);

const SENTENCE_END = /[.!?…]["”'’)\]]*$/;
const bare = (word: string) => word.toLowerCase().replace(/’/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9'-]+$/g, "");

export function dropCongregationResponses(
  words: CaptionWord[],
  levelsDb: ReadonlyMap<string, number>,
): { words: CaptionWord[]; dropped: CaptionWord[] } {
  const levels = words.map((word) => levelsDb.get(word.id)).filter((level): level is number => level !== undefined);
  if (levels.length === 0) return { words, dropped: [] };
  const sorted = [...levels].sort((a, b) => a - b);
  const quietBelow = sorted[Math.floor(sorted.length / 2)] - CONGREGATION_QUIET_DB;

  const kept: CaptionWord[] = [];
  const dropped: CaptionWord[] = [];
  let sentence: CaptionWord[] = [];
  const close = () => {
    const sentenceLevels = sentence.map((word) => levelsDb.get(word.id));
    const response =
      sentence.length > 0 &&
      sentence.every((word) => RESPONSE_WORDS.has(bare(word.word).replace(/-$/, ""))) &&
      sentenceLevels.every((level) => level !== undefined && level <= quietBelow);
    (response ? dropped : kept).push(...sentence);
    sentence = [];
  };
  for (const word of words) {
    sentence.push(word);
    if (SENTENCE_END.test(word.word)) close();
  }
  close();
  return { words: kept, dropped };
}

/**
 * Drops a word he cut off and started again ("A- and", "May- maybe", "i- listen"), then shows a
 * stammered short word once ("I, I, I, I married" reads "I married"). The word that stays shows
 * from the start of the stammer and keeps a sentence's capital letter. A repeat without a comma
 * ("that that is true") and a repeated word that is not a short one ("Holy, holy, holy") stay.
 */
export function collapseStutters(words: CaptionWord[]): CaptionWord[] {
  const capitalized = (word: CaptionWord, from: CaptionWord) =>
    /^[A-Z]/.test(from.word) && /^[a-z]/.test(word.word) ? word.word[0].toUpperCase() + word.word.slice(1) : word.word;
  const cutOff = (word: CaptionWord, next: CaptionWord | undefined) => {
    if (!next || !/[a-z]-$/i.test(word.word)) return false;
    const stem = bare(word.word).replace(/-$/, "");
    return stem.length <= 3 || bare(next.word).startsWith(stem);
  };

  const restarted: CaptionWord[] = [];
  let firstCut: CaptionWord | null = null;
  words.forEach((word, i) => {
    if (cutOff(word, words[i + 1])) {
      firstCut ??= word;
      return;
    }
    restarted.push(firstCut ? { ...word, word: capitalized(word, firstCut), startMs: firstCut.startMs } : word);
    firstCut = null;
  });

  const out: CaptionWord[] = [];
  for (const word of restarted) {
    const previous = out[out.length - 1];
    const stammer =
      previous &&
      /,["”'’]?$/.test(previous.word) &&
      STAMMER_WORDS.has(bare(word.word)) &&
      bare(previous.word) === bare(word.word);
    out.push(stammer ? { ...word, word: capitalized(word, previous), startMs: previous.startMs } : word);
    if (stammer) out.splice(out.length - 2, 1);
  }
  return out;
}

/**
 * Jake, 2026-10-19: "make subtitles full caps right now, no punctuation, and slighly larger font."
 * Drops every punctuation mark except the ones a word or number needs: an apostrophe between letters
 * ("they're", "God's"), a hyphen inside a word or number ("so-and-so", "8-9"), and a comma, period or
 * colon between digits ("2,000", "2:8").
 */
export function withoutPunctuation(text: string): string {
  const letter = /\p{L}/u;
  const digit = /\p{N}/u;
  const wordChar = /[\p{L}\p{N}]/u;
  return text
    .split(/\s+/)
    .map((token) =>
      [...token]
        .filter((char, i, chars) => {
          if (!/\p{P}/u.test(char)) return true;
          const before = chars[i - 1] ?? "";
          const after = chars[i + 1] ?? "";
          if (/['’]/.test(char)) return letter.test(before) && letter.test(after);
          if (char === "-") return wordChar.test(before) && wordChar.test(after);
          if (/[.,:]/.test(char)) return digit.test(before) && digit.test(after);
          return false;
        })
        .join(""),
    )
    .filter(Boolean)
    .join(" ");
}

/** A caption line, and each of its words, without punctuation (lab phrase captions only). */
export function withoutLinePunctuation<L extends { text: string; words: { word: string }[] }>(line: L): L {
  return {
    ...line,
    text: withoutPunctuation(line.text),
    words: line.words.map((word) => ({ ...word, word: withoutPunctuation(word.word) })).filter((word) => word.word),
  };
}
