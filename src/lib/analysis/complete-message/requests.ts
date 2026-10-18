import { z } from "zod";
import { POLICY, identifier, overlaps, transcriptProblem, transcriptSchema, type Request, type Transcript } from "./contract";

const groupsSchema = z.array(z.object({
  id: identifier, segmentIds: z.array(identifier).min(1).max(50_000),
}).strict()).max(POLICY.requests);

export type PlannedRequest = Request & { inputTokens: number };
export type RequestPlan = { status: "complete"; requests: PlannedRequest[]; inputTokens: number }
  | { status: "analysis_incomplete"; reason: string; requests: []; inputTokens: 0 };

/** Each supplied message group stays in one request, with all intervening segments and adjacent context. */
export function planMessageRequests(
  rawTranscript: unknown,
  rawGroups: unknown,
  measureInputTokens: (request: Request, transcript: Transcript) => number,
): RequestPlan {
  const stop = (reason: string): RequestPlan => ({ status: "analysis_incomplete", reason, requests: [], inputTokens: 0 });
  const parsed = transcriptSchema.safeParse(rawTranscript);
  if (!parsed.success) return stop("invalid_transcript");
  const t = parsed.data;
  const problem = transcriptProblem(t);
  if (problem) return stop(problem);
  const groups = groupsSchema.safeParse(rawGroups);
  if (!groups.success) return stop("invalid_or_excess_groups");
  if (new Set(groups.data.map((g) => g.id)).size !== groups.data.length) return stop("duplicate_group_id");
  const indexes = new Map(t.segments.map((segment, i) => [segment.id, i]));
  const requests: PlannedRequest[] = [];
  let inputTokens = 0;
  for (const group of groups.data) {
    if (new Set(group.segmentIds).size !== group.segmentIds.length) return stop("duplicate_group_reference");
    const positions = group.segmentIds.map((id) => indexes.get(id));
    if (positions.some((i) => i === undefined)) return stop("missing_context");
    const first = Math.min(...positions as number[]), last = Math.max(...positions as number[]);
    const context = {
      startMs: Math.max(0, t.segments[first].startMs - 30_000),
      endMs: Math.min(t.sourceDurationMs, t.segments[last].endMs + 30_000),
    };
    const request: Request = {
      id: group.id, revision: t.revision, origin: "message",
      segmentIds: t.segments.filter((segment) => overlaps(segment, context)).map((segment) => segment.id),
    };
    // The caller must count the full serialized request, including prompts and repeated context.
    let measured: number;
    try { measured = measureInputTokens(request, t); }
    catch { return stop("token_measurement_failed"); }
    if (!Number.isSafeInteger(measured) || measured < 0) return stop("invalid_token_measurement");
    if (measured > POLICY.inputPerRequest) return stop("context_budget_exceeded");
    if (inputTokens + measured > POLICY.totalInput) return stop("input_token_limit");
    inputTokens += measured;
    requests.push({ ...request, inputTokens: measured });
  }
  return { status: "complete", requests, inputTokens };
}
