import {
  POLICY, contains, covers, indexTranscript, overlaps, refKey, regionProblem,
  requestSchema, responseSchema, transcriptProblem, transcriptSchema,
  type Proposal, type Range, type Request, type Transcript, type Unit,
} from "./contract";

export type Accepted = {
  id: string; state: "complete"; reason: "complete_message";
  policyVersion: typeof POLICY.version; revision: string; origin: Request["origin"];
  band: "standard" | "extended"; content: Range; range: Range; evidence: Proposal["required"];
};
export type Decision = Accepted | {
  id: string; state: "incomplete" | "uncertain" | "rejected"; reason: string;
};
export type Evaluation = { ok: true; decisions: Decision[] } | { ok: false; reason: string };

function evaluate(t: Transcript, request: Request, p: Proposal, units: Map<string, Unit>): Decision {
  const refuse = (reason: string, state: "rejected" | "uncertain" | "incomplete" = "rejected"): Decision => ({ id: p.id, state, reason });
  const refs = [...p.required.map((e) => e.ref), ...(p.start ? [p.start] : []), ...(p.end ? [p.end] : [])];
  const delivered = new Set(request.segmentIds);
  for (const ref of refs) {
    const unit = units.get(refKey(ref));
    if (!unit) return refuse("unknown_reference");
    if (!delivered.has(unit.segmentId)) return refuse("evidence_outside_request");
  }
  const evidenceKeys = p.required.map((e) => refKey(e.ref));
  if (new Set(evidenceKeys).size !== evidenceKeys.length) return refuse("duplicate_evidence");
  for (const evidence of p.required) {
    if (units.get(refKey(evidence.ref))!.text !== evidence.quote) return refuse("unsupported_quote");
    if (new Set(evidence.roles).size !== evidence.roles.length) return refuse("duplicate_role");
  }
  if (p.state === "complete" && p.missingContext.length) return refuse("contradictory_judgment");
  if (p.missingContext.length) return refuse("missing_context", "uncertain");
  if (p.state !== "complete") return refuse("adapter_judgment", p.state);
  if (!p.start || !p.end || !p.required.length) return refuse("missing_message_evidence");
  const roles = new Set(p.required.flatMap((e) => e.roles));
  if (!roles.has("claim") || !roles.has("resolution")) return refuse("missing_message_evidence");
  const first = units.get(refKey(p.start))!;
  const last = units.get(refKey(p.end))!;
  const content = { startMs: first.startMs, endMs: last.endMs };
  if (content.startMs >= content.endMs) return refuse("invalid_range");
  if (p.required.some((e) => !contains(content, units.get(refKey(e.ref))!))) {
    return refuse("required_context_outside_range", "incomplete");
  }
  if (!first.startKnown || !last.endKnown) return refuse("boundary_uncertain", "uncertain");
  if (t.segments.some((segment) => segment.words.some((word) => overlaps(word, content) && !contains(content, word)))) {
    return refuse("boundary_uncertain", "uncertain");
  }
  const touched = t.segments.filter((segment) => overlaps(segment, content));
  if (touched.some((segment) => !delivered.has(segment.id))) return refuse("missing_context", "uncertain");
  if (t.gaps.some((gap) => gap.kind === "missing" && overlaps(gap, content))
    || !covers([...touched, ...t.gaps.filter((gap) => gap.kind === "silence")], content)) {
    return refuse("missing_coverage", "uncertain");
  }
  const region = regionProblem(t, content);
  if (region) return refuse(region, region === "excluded_region" ? "rejected" : "uncertain");
  const length = content.endMs - content.startMs;
  if (length < POLICY.minimumMs) return refuse("below_generation_minimum");
  if (length > POLICY.maximumMs) return refuse("message_exceeds_limit");

  // Only explicit silence can supply padding. Never include adjacent, unselected words.
  const silence = t.gaps.filter((gap) => gap.kind === "silence");
  const safe = (edge: Range) => covers(silence, edge) && !regionProblem(t, edge);
  let before = 0;
  let after = 0;
  const spare = POLICY.maximumMs - length;
  while (before < POLICY.paddingMs && before < spare && content.startMs - before > 0
    && safe({ startMs: content.startMs - before - 1, endMs: content.startMs })) before++;
  while (after < POLICY.paddingMs && before + after < spare && content.endMs + after < t.sourceDurationMs
    && safe({ startMs: content.endMs, endMs: content.endMs + after + 1 })) after++;
  return {
    id: p.id, state: "complete", reason: "complete_message", policyVersion: POLICY.version,
    revision: t.revision, origin: request.origin,
    band: length <= POLICY.standardMaximumMs ? "standard" : "extended", content,
    range: { startMs: content.startMs - before, endMs: content.endMs + after },
    evidence: p.required,
  };
}

/** Validates data only. It calls no adapter, model, database, or application service. */
export function evaluateResponse(rawTranscript: unknown, rawRequest: unknown, rawResponse: unknown): Evaluation {
  const transcript = transcriptSchema.safeParse(rawTranscript);
  if (!transcript.success) return { ok: false, reason: "invalid_transcript" };
  const problem = transcriptProblem(transcript.data);
  if (problem) return { ok: false, reason: problem };
  const request = requestSchema.safeParse(rawRequest);
  if (!request.success) return { ok: false, reason: "invalid_request" };
  const response = responseSchema.safeParse(rawResponse);
  if (!response.success) return { ok: false, reason: "malformed_response" };
  const t = transcript.data, q = request.data, r = response.data;
  if (q.revision !== t.revision || r.revision !== t.revision) return { ok: false, reason: "transcript_changed" };
  if (q.id !== r.requestId) return { ok: false, reason: "request_mismatch" };
  const segmentIds = new Set(t.segments.map((segment) => segment.id));
  if (new Set(q.segmentIds).size !== q.segmentIds.length || q.segmentIds.some((id) => !segmentIds.has(id))) {
    return { ok: false, reason: "invalid_request_references" };
  }
  if (new Set(r.proposals.map((p) => p.id)).size !== r.proposals.length) return { ok: false, reason: "duplicate_proposal_id" };
  const units = indexTranscript(t);
  return { ok: true, decisions: r.proposals.map((p) => evaluate(t, q, p, units)) };
}
