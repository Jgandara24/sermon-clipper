import { transcriptSchema, type Proposal, type Response, type Request } from "../../src/lib/analysis/complete-message/contract";
import { evaluateResponse } from "../../src/lib/analysis/complete-message/policy";
import { transcript } from "../p2-complete-message/fixtures";

export function makeCase(f = transcript([30_000])) {
  const source = transcriptSchema.parse(f.input);
  // Only these explicitly marked silent intervals can supply padding.
  source.gaps = [
    { startMs: 0, endMs: f.range.startMs, kind: "silence" },
    { startMs: f.range.endMs, endMs: source.sourceDurationMs, kind: "silence" },
  ];
  const request: Request = {
    id: `request-${source.revision}`, revision: source.revision, origin: "message",
    segmentIds: source.segments.map((s) => s.id),
  };
  const proposal: Proposal = {
    id: `proposal-${source.revision}`, state: "complete",
    start: { kind: "segment", id: source.segments[0].id },
    end: { kind: "segment", id: source.segments.at(-1)!.id },
    required: source.segments.map((s, i) => ({
      ref: { kind: "segment", id: s.id }, quote: s.text,
      roles: i === 0 && source.segments.length === 1 ? ["claim", "resolution"]
        : i === 0 ? ["claim"] : i === source.segments.length - 1 ? ["resolution"] : ["development"],
    })),
    missingContext: [], reason: "The supplied claim and resolution form a complete message.",
  };
  const response: Response = { version: 1, revision: source.revision, requestId: request.id, proposals: [proposal] };
  return { source, request, proposal, response, offset: f.offset, range: f.range };
}

export function decision(f: ReturnType<typeof makeCase>) {
  const result = evaluateResponse(f.source, f.request, f.response);
  if (!result.ok) throw new Error(`Unexpected contract refusal: ${result.reason}`);
  return result.decisions[0];
}
