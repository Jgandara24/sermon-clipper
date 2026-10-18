// Stage 1 test model only. Do not import this file from application code.
// Meaning comes from a supplied fake response. This helper does not infer meaning.
export type Range = { startMs: number; endMs: number };
export type Word = Range & { id: string; text: string };
export type Segment = Range & { id: string; text: string; words: Word[] };
export type Transcript = {
  revision: string;
  sourceDurationMs?: number;
  segments: Segment[];
  regions: Array<Range & { kind: "allowed" | "excluded" | "uncertain" }>;
  gaps: Array<Range & { kind: "silence" | "missing" }>;
};
export type FakeJudgment = {
  revision: string;
  state: "complete" | "incomplete" | "uncertain";
  requiredIds: string[];
  evidence: Array<{ segmentId: string; quote: string }>;
  unresolvedContext: boolean;
};
export type Result = {
  state: "complete" | "incomplete" | "uncertain" | "rejected";
  reason: string;
  range?: Range;
};

const validTime = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const overlaps = (a: Range, b: Range) => a.startMs < b.endMs && b.startMs < a.endMs;
const contains = (a: Range, b: Range) => a.startMs <= b.startMs && a.endMs >= b.endMs;
const reject = (reason: string): Result => ({ state: "rejected", reason });
const uncertain = (reason: string): Result => ({ state: "uncertain", reason });

function validRange(range: Range, duration: number): boolean {
  return validTime(range.startMs) && validTime(range.endMs)
    && range.startMs < range.endMs && range.endMs <= duration;
}

function transcriptProblem(t: Transcript): string | undefined {
  if (!validTime(t.sourceDurationMs) || t.sourceDurationMs === 0) return "invalid_source";
  if (!t.revision || !t.segments.length) return "invalid_transcript";
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const segment of t.segments) {
    if (!segment.id || ids.has(segment.id)) return "duplicate_or_empty_id";
    ids.add(segment.id);
    if (!validRange(segment, t.sourceDurationMs) || segment.startMs < previousEnd) return "invalid_segments";
    previousEnd = segment.endMs;
    let wordEnd = segment.startMs;
    for (const word of segment.words) {
      if (!word.id || ids.has(word.id)) return "duplicate_or_empty_id";
      ids.add(word.id);
      if (!validRange(word, t.sourceDurationMs) || !contains(segment, word) || word.startMs < wordEnd) {
        return "invalid_words";
      }
      wordEnd = word.endMs;
    }
  }
  if ([...t.regions, ...t.gaps].some((range) => !validRange(range, t.sourceDurationMs!))) {
    return "invalid_coverage";
  }
}

function judgmentShape(value: unknown): value is FakeJudgment {
  if (!value || typeof value !== "object") return false;
  const j = value as Partial<FakeJudgment>;
  return typeof j.revision === "string"
    && ["complete", "incomplete", "uncertain"].includes(j.state ?? "")
    && typeof j.unresolvedContext === "boolean"
    && Array.isArray(j.requiredIds) && j.requiredIds.length > 0
    && j.requiredIds.every((id) => typeof id === "string")
    && Array.isArray(j.evidence) && j.evidence.every((e) => e && typeof e === "object"
      && typeof e.segmentId === "string" && typeof e.quote === "string" && e.quote.length > 0);
}

function regionProblem(t: Transcript, range: Range): string | undefined {
  const touched = t.regions.filter((region) => overlaps(region, range));
  if (touched.some((region) => region.kind === "excluded")) return "excluded_region";
  if (touched.some((region) => region.kind === "uncertain")) return "region_uncertain";
  let coveredTo = range.startMs;
  for (const region of touched.sort((a, b) => a.startMs - b.startMs)) {
    if (region.startMs > coveredTo) return "region_uncertain";
    coveredTo = Math.max(coveredTo, region.endMs);
  }
  if (coveredTo < range.endMs) return "region_uncertain";
}

/** Tests fixed policy examples against independently supplied fake meaning judgments. */
export function inspectProposal(t: Transcript, range: Range, response: unknown, padMs = 150): Result {
  const problem = transcriptProblem(t);
  if (problem) return reject(problem);
  const duration = t.sourceDurationMs!;
  if (!validRange(range, duration)) return reject("invalid_range");
  if (!validTime(padMs) || padMs > 150) return reject("invalid_padding");
  if (!judgmentShape(response)) return reject("malformed_judgment");
  if (response.revision !== t.revision) return uncertain("transcript_changed");
  if (new Set(response.requiredIds).size !== response.requiredIds.length) return reject("duplicate_reference");
  if (new Set(response.evidence.map((e) => e.segmentId)).size !== response.evidence.length) {
    return reject("duplicate_reference");
  }
  const byId = new Map(t.segments.map((segment) => [segment.id, segment]));
  for (const evidence of response.evidence) {
    const segment = byId.get(evidence.segmentId);
    if (!segment || !segment.text.includes(evidence.quote)) return reject("unsupported_evidence");
  }
  for (const id of response.requiredIds) {
    if (!byId.has(id)) return uncertain("missing_context");
    if (!response.evidence.some((e) => e.segmentId === id)) return reject("missing_evidence");
  }
  if (response.unresolvedContext) return uncertain("missing_context");
  if (response.state !== "complete") return { state: response.state, reason: "adapter_judgment" };
  if (response.requiredIds.some((id) => !contains(range, byId.get(id)!))) {
    return { state: "incomplete", reason: "required_context_outside_range" };
  }
  const region = regionProblem(t, range);
  if (region === "excluded_region") return reject(region);
  if (region) return uncertain(region);
  if (t.gaps.some((gap) => gap.kind === "missing" && overlaps(gap, range))) return uncertain("missing_coverage");
  // Segment edges without word times remain uncertain in this deliberately conservative model.
  const words = t.segments.flatMap((segment) => segment.words);
  if (!words.some((word) => word.startMs === range.startMs)
    || !words.some((word) => word.endMs === range.endMs)
    || words.some((word) => overlaps(word, range) && !contains(range, word))) {
    return uncertain("boundary_uncertain");
  }
  const length = range.endMs - range.startMs;
  if (length < 20_000) return reject("below_generation_minimum");
  if (length > 180_000) return reject("message_exceeds_limit");

  // Padding cannot enter other speech, missing coverage, or a region without clearance.
  let left = Math.max(0, range.startMs - padMs);
  let right = Math.min(duration, range.endMs + padMs);
  for (const segment of t.segments) {
    if (segment.endMs <= range.startMs) left = Math.max(left, segment.endMs);
    if (segment.startMs >= range.endMs) right = Math.min(right, segment.startMs);
  }
  for (const gap of t.gaps.filter((gap) => gap.kind === "missing")) {
    if (gap.endMs <= range.startMs) left = Math.max(left, gap.endMs);
    if (gap.startMs >= range.endMs) right = Math.min(right, gap.startMs);
  }
  // Integer checks let each edge use only the cleared milliseconds nearest the message.
  while (left < range.startMs && regionProblem(t, { startMs: left, endMs: range.endMs })) left++;
  while (right > range.endMs && regionProblem(t, { startMs: range.startMs, endMs: right })) right--;
  const spare = 180_000 - length;
  // Stage 1 tie rule: spend the remaining padding on the left edge first.
  const before = Math.min(range.startMs - left, spare);
  const after = Math.min(right - range.endMs, spare - before);
  return {
    state: "complete", reason: "supplied_message_complete",
    range: { startMs: range.startMs - before, endMs: range.endMs + after },
  };
}

export class FakeClock {
  milliseconds = 0;
  advance(ms: number): void {
    if (!validTime(ms)) throw new Error("Invalid fake time.");
    this.milliseconds += ms;
  }
}

export type FakeRequest = { inputTokens: number; outputTokens: number; elapsedMs: number };
export class WorkBudget {
  readonly counts = { requests: 0, inputTokens: 0, outputTokens: 0 };
  readonly startedAt: number;
  stopReason?: string;
  constructor(readonly clock: FakeClock) { this.startedAt = clock.milliseconds; }

  /** A reservation consumes tokens even when the fake request times out or represents a retry. */
  request(request: FakeRequest): boolean {
    if (this.stopReason) return false;
    const { inputTokens, outputTokens, elapsedMs } = request;
    let reason: string | undefined;
    if (![inputTokens, outputTokens, elapsedMs].every(validTime)) reason = "invalid_budget_input";
    else if (this.clock.milliseconds - this.startedAt >= 300_000) reason = "analysis_time_limit";
    else if (this.counts.requests >= 60) reason = "request_limit";
    else if (inputTokens > 12_000) reason = "context_budget_exceeded";
    else if (this.counts.inputTokens + inputTokens > 120_000) reason = "input_token_limit";
    else if (this.counts.outputTokens + outputTokens > 24_000) reason = "output_token_limit";
    if (reason) { this.stopReason = reason; return false; }
    this.counts.requests++;
    this.counts.inputTokens += inputTokens;
    this.counts.outputTokens += outputTokens;
    const remaining = 300_000 - (this.clock.milliseconds - this.startedAt);
    this.clock.advance(Math.min(elapsedMs, 60_000, remaining));
    if (elapsedMs > remaining && remaining <= 60_000) this.stopReason = "analysis_time_limit";
    else if (elapsedMs > 60_000) this.stopReason = "request_time_limit";
    return !this.stopReason;
  }
}

/** Uses supplied token counts. It never truncates a segment or measures real provider tokens. */
export function packWholeSegments(ids: string[], tokenCounts: Map<string, number>): string[][] | undefined {
  const batches: string[][] = [];
  let tokens = 0;
  for (const id of ids) {
    const count = tokenCounts.get(id);
    if (!validTime(count) || count > 12_000) return undefined;
    if (!batches.length || tokens + count > 12_000) { batches.push([]); tokens = 0; }
    batches[batches.length - 1].push(id);
    tokens += count;
  }
  return batches;
}

export function searchBlocks(sourceDurationMs: number): Array<Range & { context: Range }> {
  if (!validTime(sourceDurationMs) || sourceDurationMs === 0) return [];
  const blocks: Array<Range & { context: Range }> = [];
  for (let startMs = 0; startMs < sourceDurationMs; startMs += 180_000) {
    const endMs = Math.min(sourceDurationMs, startMs + 360_000);
    blocks.push({ startMs, endMs, context: {
      startMs: Math.max(0, startMs - 30_000), endMs: Math.min(sourceDurationMs, endMs + 30_000),
    } });
    if (endMs === sourceDurationMs) break;
  }
  return blocks;
}

export type Proposal = Range & { id: string; origin: "short" | "message"; result: Result };
function sample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count === 0) return [];
  if (count === 1) return [items[0]];
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * (items.length - 1) / (count - 1))]);
}

/** Fixed admission experiment. No overlap calculation or duplicate removal occurs here. */
export function admit(proposals: Proposal[]) {
  const order = (a: Proposal, b: Proposal) => a.startMs - b.startMs || a.id.localeCompare(b.id);
  const complete = proposals.filter((proposal) => proposal.result.state === "complete").sort(order);
  const short = complete.filter((proposal) => proposal.origin === "short");
  const message = complete.filter((proposal) => proposal.origin === "message");
  const shortCount = Math.min(short.length, 250 + Math.max(0, 250 - message.length));
  const messageCount = Math.min(message.length, 500 - shortCount);
  const candidates = [...sample(short, shortCount), ...sample(message, messageCount)].sort(order);
  return { candidates, scoring: sample(candidates, 25), dropped: proposals.length - candidates.length };
}

/** Stage 1 returns evidence only. Even a complete rehearsal never writes a saved pool. */
export function rehearse<T>(existingPool: readonly T[], requests: FakeRequest[], proposals: Proposal[], clock: FakeClock) {
  const budget = new WorkBudget(clock);
  for (const request of requests) if (!budget.request(request)) break;
  return {
    status: budget.stopReason ? "analysis_incomplete" : "complete",
    reason: budget.stopReason,
    budget: budget.counts,
    savedPool: existingPool,
    evidence: admit(proposals),
  };
}
