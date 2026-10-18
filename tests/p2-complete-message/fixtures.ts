import type { FakeJudgment, Range, Transcript } from "./harness";

let sequence = 0;

// All text and times are invented. Sparse words test timing, not natural speaking speed.
export function transcript(durations: number[], texts?: string[]) {
  const serial = ++sequence;
  const offset = 1_000 + serial * 1_000;
  let startMs = offset;
  const segments = durations.map((duration, i) => {
    const text = texts?.[i] ?? `A gardener explains lesson ${i + 1}.`;
    const tokens = text.split(/\s+/);
    const endMs = startMs + duration;
    const segment = {
      id: `fixture-${serial}-segment-${i}`, startMs, endMs, text,
      words: tokens.map((text, j) => ({
        id: `fixture-${serial}-word-${i}-${j}`, text,
        startMs: startMs + Math.floor(j * duration / tokens.length),
        endMs: startMs + Math.floor((j + 1) * duration / tokens.length),
      })),
    };
    startMs = endMs;
    return segment;
  });
  const sourceDurationMs = startMs + 1_000;
  const input: Transcript = {
    revision: `fixture-revision-${serial}`, sourceDurationMs, segments,
    regions: [{ startMs: 0, endMs: sourceDurationMs, kind: "allowed" }], gaps: [],
  };
  return { input, offset, range: { startMs: offset, endMs: startMs } };
}

/** A scripted adapter answer. Expected test outcomes never enter this response. */
export function judgment(input: Transcript, requiredIndexes = input.segments.map((_, i) => i)): FakeJudgment {
  return {
    revision: input.revision, state: "complete", unresolvedContext: false,
    requiredIds: requiredIndexes.map((i) => input.segments[i].id),
    evidence: requiredIndexes.map((i) => ({ segmentId: input.segments[i].id, quote: input.segments[i].text })),
  };
}

export function segmentRange(input: Transcript, first: number, last: number): Range {
  return { startMs: input.segments[first].startMs, endMs: input.segments[last].endMs };
}

export function shortComplete() {
  return transcript([12_000, 12_000, 16_000, 16_620], [
    "A garden needs regular care.", "Some people expect growth without effort.",
    "But roots need water during dry weather.", "Therefore we tend the soil even before leaves appear.",
  ]);
}

export function sentenceNotMessage() {
  return transcript([30_000, 37_000, 45_000, 40_000], [
    "A bridge needs both banks.", "One bank gives the first support.",
    "That support alone cannot carry the crossing.", "Both supports together let the bridge carry its load.",
  ]);
}

export function earlierContext() {
  return transcript([15_000, 28_000, 30_000, 30_000], [
    "A seed and a stone can look alike.", "This one grows because it contains life.",
    "The other stays the same despite the rain.", "Growth depends on what is inside, not appearance alone.",
  ]);
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
