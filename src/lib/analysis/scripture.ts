export type ScriptureReference = {
  detectedText: string;
  normalized: string;
  book: string;
  chapterStart: number;
  verseStart: number | null;
  chapterEnd: number | null;
  verseEnd: number | null;
  confidence: number;
};

const BOOK_ALIASES: Array<[RegExp, string]> = [
  [/\bgenesis\b/gi, "Genesis"],
  [/\bexodus\b/gi, "Exodus"],
  [/\bromans\b/gi, "Romans"],
  [/\bjohn\b/gi, "John"],
  [/\b1\s*corinthians\b|\bfirst\s+corinthians\b/gi, "1 Corinthians"],
  [/\b2\s*corinthians\b|\bsecond\s+corinthians\b/gi, "2 Corinthians"],
  [/\bgalatians\b/gi, "Galatians"],
  [/\bephesians\b/gi, "Ephesians"],
  [/\bphilippians\b/gi, "Philippians"],
  [/\bcolossians\b/gi, "Colossians"],
  [/\bhebrews\b/gi, "Hebrews"],
  [/\bjames\b/gi, "James"],
  [/\b1\s*peter\b|\bfirst\s+peter\b/gi, "1 Peter"],
  [/\b2\s*peter\b|\bsecond\s+peter\b/gi, "2 Peter"],
  [/\b1\s*john\b|\bfirst\s+john\b/gi, "1 John"],
  [/\b2\s*john\b|\bsecond\s+john\b/gi, "2 John"],
  [/\b3\s*john\b|\bthird\s+john\b/gi, "3 John"],
  [/\bjude\b/gi, "Jude"],
  [/\brevelation\b/gi, "Revelation"],
  [/\bpsalms?\b/gi, "Psalms"],
  [/\bproverbs\b/gi, "Proverbs"],
  [/\bisaiah\b/gi, "Isaiah"],
  [/\bjeremiah\b/gi, "Jeremiah"],
  [/\bmatthew\b/gi, "Matthew"],
  [/\bmark\b/gi, "Mark"],
  [/\bluke\b/gi, "Luke"],
  [/\bacts\b/gi, "Acts"],
];

const NUMBER_WORDS = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
]);

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  return NUMBER_WORDS.get(value.toLowerCase()) ?? null;
}

function normalizeBookName(text: string): string | null {
  for (const [pattern, book] of BOOK_ALIASES) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return book;
  }
  return null;
}

function normalizedLabel(book: string, chapterStart: number, verseStart: number | null, verseEnd: number | null) {
  if (verseStart == null) return `${book} ${chapterStart}`;
  if (verseEnd != null && verseEnd !== verseStart) return `${book} ${chapterStart}:${verseStart}-${verseEnd}`;
  return `${book} ${chapterStart}:${verseStart}`;
}

export function detectScriptureReferences(text: string): ScriptureReference[] {
  const refs: ScriptureReference[] = [];
  const seen = new Set<string>();

  const explicitPattern =
    /\b((?:[123]|first|second|third)?\s*[A-Za-z]+)\s+(\d{1,3})\s*:\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/gi;
  for (const match of text.matchAll(explicitPattern)) {
    const book = normalizeBookName(match[1]);
    const chapterStart = parseNumber(match[2]);
    const verseStart = parseNumber(match[3]);
    const verseEnd = parseNumber(match[4]);
    if (!book || chapterStart == null || verseStart == null) continue;

    const normalized = normalizedLabel(book, chapterStart, verseStart, verseEnd);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    refs.push({
      detectedText: match[0],
      normalized,
      book,
      chapterStart,
      verseStart,
      chapterEnd: null,
      verseEnd,
      confidence: 0.92,
    });
  }

  const chapterPattern =
    /\b(?:book\s+of\s+)?((?:[123]|first|second|third)?\s*[A-Za-z]+),?\s+chapter\s+(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/gi;
  for (const match of text.matchAll(chapterPattern)) {
    const book = normalizeBookName(match[1]);
    const chapterStart = parseNumber(match[2]);
    if (!book || chapterStart == null) continue;

    const normalized = normalizedLabel(book, chapterStart, null, null);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    refs.push({
      detectedText: match[0],
      normalized,
      book,
      chapterStart,
      verseStart: null,
      chapterEnd: null,
      verseEnd: null,
      confidence: 0.74,
    });
  }

  const shorthandChapterPattern =
    /\b((?:[123]|first|second|third)?\s*[A-Za-z]+)\s+(\d{1,3})(?!\s*:)\b/gi;
  for (const match of text.matchAll(shorthandChapterPattern)) {
    const book = normalizeBookName(match[1]);
    const chapterStart = parseNumber(match[2]);
    if (!book || chapterStart == null) continue;

    const normalized = normalizedLabel(book, chapterStart, null, null);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    refs.push({
      detectedText: match[0],
      normalized,
      book,
      chapterStart,
      verseStart: null,
      chapterEnd: null,
      verseEnd: null,
      confidence: 0.8,
    });
  }

  return refs;
}

export function summarizeScriptureReferences(refs: ScriptureReference[]): string {
  if (refs.length === 0) return "No explicit scripture reference detected.";
  return `Detected ${refs.map((ref) => ref.normalized).join(", ")}.`;
}
