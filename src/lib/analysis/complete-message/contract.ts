import { z } from "zod";

// Versioned pure contract. The handler uses it only through the explicit complete-message policy.
export const POLICY = Object.freeze({
  version: "complete-message-v1",
  minimumMs: 20_000, standardMaximumMs: 90_000, maximumMs: 180_000, paddingMs: 150,
  candidates: 500, scoring: 25, requests: 60,
  inputPerRequest: 12_000, totalInput: 120_000, totalOutput: 24_000,
  requestMs: 60_000, analysisMs: 300_000,
});

export const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const identifier = z.string().min(1).max(200).refine((value) => value === value.trim());
const id = identifier;
const text = z.string().min(1).max(100_000);
const rangeFields = { startMs: integer, endMs: integer };
export const rangeSchema = z.object(rangeFields).strict();
const wordSchema = z.object({ ...rangeFields, id, text }).strict();
const segmentSchema = z.object({
  ...rangeFields, id, text, words: z.array(wordSchema).max(10_000),
  // These assertions belong to trusted transcript input, never to a model response.
  verifiedStart: z.boolean().default(false), verifiedEnd: z.boolean().default(false),
}).strict();
export const transcriptSchema = z.object({
  revision: id, sourceDurationMs: integer.positive(),
  segments: z.array(segmentSchema).min(1).max(50_000),
  regions: z.array(z.object({ ...rangeFields, kind: z.enum(["allowed", "excluded", "uncertain"]) }).strict()).max(50_000),
  gaps: z.array(z.object({ ...rangeFields, kind: z.enum(["silence", "missing"]) }).strict()).max(50_000),
}).strict();

export const refSchema = z.object({ kind: z.enum(["segment", "word"]), id }).strict();
const evidenceSchema = z.object({
  ref: refSchema, quote: text,
  roles: z.array(z.enum(["claim", "context", "development", "objection", "resolution"])).min(1).max(5),
}).strict();
export const proposalSchema = z.object({
  id, state: z.enum(["complete", "incomplete", "uncertain"]),
  start: refSchema.nullable(), end: refSchema.nullable(),
  required: z.array(evidenceSchema).max(2_000),
  missingContext: z.array(z.string().min(1).max(1_000)).max(50),
  reason: z.string().min(1).max(2_000),
}).strict();
export const requestSchema = z.object({
  id, revision: id, origin: z.enum(["short", "message"]),
  segmentIds: z.array(id).min(1).max(50_000),
}).strict();
export const responseSchema = z.object({
  version: z.literal(1), requestId: id, revision: id,
  proposals: z.array(proposalSchema).max(POLICY.candidates),
}).strict();

export type Range = z.infer<typeof rangeSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;
export type Reference = z.infer<typeof refSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type Request = z.infer<typeof requestSchema>;
export type Response = z.infer<typeof responseSchema>;
export type Unit = Range & { id: string; text: string; segmentId: string; startKnown: boolean; endKnown: boolean };
export const refKey = (ref: Reference) => `${ref.kind}:${ref.id}`;
export const contains = (outer: Range, inner: Range) => outer.startMs <= inner.startMs && outer.endMs >= inner.endMs;
export const overlaps = (a: Range, b: Range) => a.startMs < b.endMs && b.startMs < a.endMs;
export const validRange = (range: Range, duration: number) => range.startMs < range.endMs && range.endMs <= duration;

export function indexTranscript(t: Transcript): Map<string, Unit> {
  const units = new Map<string, Unit>();
  for (const segment of t.segments) {
    units.set(refKey({ kind: "segment", id: segment.id }), {
      ...segment, segmentId: segment.id,
      startKnown: segment.verifiedStart || segment.words[0]?.startMs === segment.startMs,
      endKnown: segment.verifiedEnd || segment.words.at(-1)?.endMs === segment.endMs,
    });
    for (const word of segment.words) units.set(refKey({ kind: "word", id: word.id }), {
      ...word, segmentId: segment.id, startKnown: true, endKnown: true,
    });
  }
  return units;
}

export function transcriptProblem(t: Transcript): string | undefined {
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const segment of t.segments) {
    if (ids.has(segment.id)) return "duplicate_source_id";
    ids.add(segment.id);
    if (!validRange(segment, t.sourceDurationMs) || segment.startMs < previousEnd) return "invalid_segment_times";
    previousEnd = segment.endMs;
    let wordEnd = segment.startMs;
    for (const word of segment.words) {
      if (ids.has(word.id)) return "duplicate_source_id";
      ids.add(word.id);
      if (!validRange(word, t.sourceDurationMs) || !contains(segment, word) || word.startMs < wordEnd) return "invalid_word_times";
      wordEnd = word.endMs;
    }
  }
  for (const range of [...t.regions, ...t.gaps]) {
    if (!validRange(range, t.sourceDurationMs)) return "invalid_coverage_times";
  }
  for (const gap of t.gaps) {
    if (t.segments.some((segment) => overlaps(gap, segment))) return "coverage_conflict";
    if (t.gaps.some((other) => other.kind !== gap.kind && overlaps(gap, other))) return "coverage_conflict";
  }
}

export function covers(ranges: readonly Range[], target: Range): boolean {
  let end = target.startMs;
  for (const range of [...ranges].sort((a, b) => a.startMs - b.startMs)) {
    if (range.endMs <= end) continue;
    if (range.startMs > end) return false;
    end = range.endMs;
    if (end >= target.endMs) return true;
  }
  return end >= target.endMs;
}

export function regionProblem(t: Transcript, range: Range): string | undefined {
  const regions = t.regions.filter((region) => overlaps(region, range));
  if (regions.some((region) => region.kind === "excluded")) return "excluded_region";
  if (regions.some((region) => region.kind === "uncertain") || !covers(regions, range)) return "region_uncertain";
}
