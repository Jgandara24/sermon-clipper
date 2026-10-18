import { z } from "zod";
import { POLICY, identifier, requestSchema, responseSchema } from "./contract";
import { initialBudget, finishWork, type Budget } from "./budget";
import { prepareRequest, verifyPreparedRequest, reservePreparedRequest,
  snapshotJson, PreparationFailure, REQUEST_OUTPUT_LIMITS,
  type InputMeter, type PreparedRequest, type PreparedIdentity, type RequestRoute } from "./prepared-request";
import type { AnalysisModelCall } from "../usage";
import type { AnalysisModelPrice } from "../routing";

export const ANTHROPIC_MESSAGE_SCHEMA_VERSION = "complete-message-anthropic-v1";
export const MAX_MESSAGE_RESPONSE_BYTES = 262144;
type Stage = RequestRoute["stage"];
type Route = { model: string; pricing: AnalysisModelPrice | null };
export type MockableAnthropicTransport = (bodyJson: string, options: {
  signal: AbortSignal; maxRetries: 0; maxResponseBytes: number;
}) => Promise<unknown>;
export type AnthropicResult = {
  ok: true; output: unknown; usage: AnalysisModelCall; usageState: "known"; budget: Budget;
} | {
  ok: false; reason: string; usage: AnalysisModelCall | null;
  usageState: "known" | "unknown" | "not_requested"; budget: Budget;
};

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const usageSchema = z.object({
  input_tokens: count, output_tokens: count, cache_creation_input_tokens: count, cache_read_input_tokens: count,
});
const score = z.object({ score: z.number().int().min(0).max(100), note: z.string().max(2000) }).strict();
const scoringSchema = z.object({ scoredClips: z.array(z.object({
  index: z.number().int().min(0).max(POLICY.scoring - 1), title: z.string().max(200),
  hookText: z.string().max(2000), summary: z.string().max(4000), excerpt: z.string().max(100000),
  subscores: z.object({ hookStrength: score, clarity: score, emotionalImpact: score,
    completeness: score, shareability: score, topicRelevance: score }).strict(),
}).strict()).max(POLICY.scoring) }).strict();
const classificationSchema = responseSchema.extend({ proposals: responseSchema.shape.proposals.max(32) });
const schemas = { analysis_classification: classificationSchema, analysis_scoring: scoringSchema };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PreparationFailure("invalid_payload");
  return value as Record<string, unknown>;
}
function payloadIdentity(stage: Stage, payload: unknown) {
  const data = record(payload);
  if (stage === "analysis_classification") {
    const request = requestSchema.safeParse(data.request);
    if (!request.success) throw new PreparationFailure("invalid_request_identity");
    return { requestId: request.data.id, revision: request.data.revision, indexes: [] as number[] };
  }
  const candidates = z.array(z.object({ index: z.number().int().nonnegative() }))
    .min(1).max(POLICY.scoring).safeParse(data.candidates);
  if (!candidates.success || candidates.data.some((c, i) => c.index !== i)) throw new PreparationFailure("invalid_candidate_indexes");
  return { requestId: "", revision: "", indexes: candidates.data.map((c) => c.index) };
}
function bodyFor(route: RequestRoute, payload: unknown, maxOutputTokens: number) {
  payloadIdentity(route.stage, payload);
  // Zod attaches non-enumerable metadata. Serialize its generated schema, never the caller's payload.
  const schema = JSON.parse(JSON.stringify(z.toJSONSchema(schemas[route.stage])));
  delete schema.$schema;
  return snapshotJson({ model: route.model, max_tokens: maxOutputTokens, thinking: { type: "disabled" },
    messages: [{ role: "user", content: JSON.stringify(snapshotJson(payload)) }],
    output_config: { format: { type: "json_schema", schema } },
  });
}

/** Disconnected capability. No SDK, fetch, environment, or default transport is installed here. */
export class DisconnectedAnthropicAdapter {
  private budget: Budget;
  private readonly routes: Readonly<Record<Stage, Route>>;
  constructor(routes: Record<Stage, Route>, private readonly meter: InputMeter,
    private readonly transport: MockableAnthropicTransport, private readonly now: () => number = Date.now) {
    for (const route of Object.values(routes)) identifier.parse(route.model);
    this.routes = snapshotJson(routes) as typeof routes;
    this.budget = initialBudget(now());
  }
  private route(stage: Stage): RequestRoute {
    return { stage, provider: "anthropic", model: this.routes[stage].model, schemaVersion: ANTHROPIC_MESSAGE_SCHEMA_VERSION };
  }
  private snapshot(): Budget {
    return Object.freeze({ ...this.budget, pending: this.budget.pending ? Object.freeze({ ...this.budget.pending }) : null });
  }
  prepare(stage: Stage, payload: unknown): PreparedRequest {
    const route = this.route(stage), maxOutputTokens = REQUEST_OUTPUT_LIMITS[stage];
    return prepareRequest({ route, body: bodyFor(route, payload, maxOutputTokens), maxOutputTokens }, this.meter);
  }
  private failed(reason: string, usage: AnalysisModelCall | null,
    usageState: "known" | "unknown" | "not_requested"): AnthropicResult {
    this.budget = { ...this.budget, stopReason: this.budget.stopReason ?? reason };
    return { ok: false, reason, usage: usage ? { ...usage, outcome: "failed" } : null, usageState, budget: this.snapshot() };
  }

  async dispatch(request: PreparedRequest, identity: PreparedIdentity, signal: AbortSignal): Promise<AnthropicResult> {
    let dispatched = false;
    let usage: AnalysisModelCall | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const controller = new AbortController();
    try {
      verifyPreparedRequest(request, identity);
      const route = this.route(request.route.stage);
      verifyPreparedRequest(request, { ...identity, route, maxOutputTokens: REQUEST_OUTPUT_LIMITS[route.stage] });
      const body = record(request.body);
      const messages = z.array(z.object({ content: z.string() })).length(1).parse(body.messages);
      const payload = JSON.parse(messages[0].content);
      if (JSON.stringify(bodyFor(route, payload, request.maxOutputTokens)) !== request.bodyJson) {
        throw new PreparationFailure("provider_body_changed");
      }
      const expected = payloadIdentity(route.stage, payload);
      if (signal.aborted) throw new PreparationFailure("cancelled");
      const id = `anthropic-${this.budget.requests + 1}`;
      this.budget = reservePreparedRequest(this.budget, id, request, identity, this.now());
      if (this.budget.stopReason || !this.budget.pending) throw new PreparationFailure(this.budget.stopReason ?? "reservation_failed");
      const started = this.now();
      const deadline = this.budget.pending.deadlineMs;
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => { controller.abort(); reject(new PreparationFailure("cancelled")); };
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          controller.abort(); reject(new PreparationFailure("request_deadline"));
        }, Math.max(0, deadline - this.now()));
      });
      const raw = await Promise.race([
        Promise.resolve().then(() => {
          if (signal.aborted || controller.signal.aborted) throw new PreparationFailure("cancelled");
          if (this.now() >= deadline) throw new PreparationFailure("request_deadline");
          dispatched = true;
          return this.transport(request.bodyJson, { signal: controller.signal, maxRetries: 0,
            maxResponseBytes: MAX_MESSAGE_RESPONSE_BYTES });
        }), interrupted,
      ]);
      const response = record(raw);
      const counts = usageSchema.safeParse(response.usage);
      if (!counts.success) throw new PreparationFailure("usage_unknown");
      const u = counts.data;
      const totalInput = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
      if (!Number.isSafeInteger(totalInput)) throw new PreparationFailure("usage_unknown");
      const reportedModel = identifier.safeParse(response.model);
      if (!reportedModel.success) throw new PreparationFailure("usage_unknown");
      usage = { stage: route.stage, provider: "anthropic", model: reportedModel.data,
        inputTokens: u.input_tokens, outputTokens: u.output_tokens,
        cacheCreationInputTokens: u.cache_creation_input_tokens, cacheReadInputTokens: u.cache_read_input_tokens,
        wallTimeMs: this.now() - started,
        pricing: reportedModel.data === route.model ? this.routes[route.stage].pricing : null, outcome: "failed" };
      this.budget = finishWork(this.budget, { id, inputTokens: totalInput, outputTokens: u.output_tokens }, this.now());
      if (this.budget.stopReason) throw new PreparationFailure(this.budget.stopReason);
      if (response.model !== route.model) throw new PreparationFailure("response_model_changed");
      if (response.stop_reason === "max_tokens") throw new PreparationFailure("truncated_response");
      if (response.stop_reason !== "end_turn") throw new PreparationFailure("unexpected_completion");
      const content = z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()).length(1).safeParse(response.content);
      if (!content.success) throw new PreparationFailure("invalid_content");
      const text = content.data[0].text;
      if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_RESPONSE_BYTES) throw new PreparationFailure("response_byte_limit");
      let output: unknown;
      try { output = JSON.parse(text); } catch { throw new PreparationFailure("malformed_response"); }
      const parsed = schemas[route.stage].safeParse(output);
      if (!parsed.success) throw new PreparationFailure("invalid_response_schema");
      if (route.stage === "analysis_classification") {
        const answer = classificationSchema.parse(parsed.data);
        if (answer.requestId !== expected.requestId || answer.revision !== expected.revision) throw new PreparationFailure("response_identity_changed");
      } else {
        const indexes = scoringSchema.parse(parsed.data).scoredClips.map((clip) => clip.index);
        if (indexes.length !== expected.indexes.length || new Set(indexes).size !== indexes.length ||
            indexes.some((index) => !expected.indexes.includes(index))) throw new PreparationFailure("incomplete_scores");
      }
      return { ok: true, output: snapshotJson(parsed.data), usage: { ...usage, outcome: "succeeded" },
        usageState: "known", budget: this.snapshot() };
    } catch (error) {
      controller.abort();
      return this.failed(error instanceof PreparationFailure ? error.reason : "adapter_failed", usage,
        usage ? "known" : dispatched ? "unknown" : "not_requested");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
}
