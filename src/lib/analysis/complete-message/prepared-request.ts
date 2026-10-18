import { createHash } from "node:crypto";
import { z } from "zod";
import { POLICY, identifier } from "./contract";
import { reserveWork, type Budget } from "./budget";

export const REQUEST_OUTPUT_LIMITS = Object.freeze({ analysis_classification: 1024, analysis_scoring: 2048 });
const routeSchema = z.object({
  stage: z.enum(["analysis_classification", "analysis_scoring"]),
  provider: z.enum(["anthropic", "google"]), model: identifier, schemaVersion: identifier,
}).strict();
export type RequestRoute = Readonly<z.infer<typeof routeSchema>>;
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export class PreparationFailure extends Error {
  constructor(readonly reason: string) { super(`Request preparation stopped: ${reason}`); }
}

/** Copy JSON without invoking getters, dropping fields, or retaining mutable caller references. */
export function snapshotJson(value: unknown): Json {
  const ancestors = new Set<object>();
  function copy(v: unknown, depth: number): Json {
    if (depth > 64) throw new PreparationFailure("json_depth_limit");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return Object.is(v, -0) ? 0 : v;
    if (!v || typeof v !== "object" || ancestors.has(v)) throw new PreparationFailure("invalid_json");
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
      throw new PreparationFailure("invalid_json");
    }
    ancestors.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(v).some((k) => typeof k !== "string")) throw new PreparationFailure("invalid_json");
    let result: Json;
    if (Array.isArray(v)) {
      if (Object.keys(descriptors).length !== v.length + 1) throw new PreparationFailure("invalid_json");
      const items: Json[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = descriptors[String(i)];
        if (!d || !("value" in d) || !d.enumerable) throw new PreparationFailure("invalid_json");
        items.push(copy(d.value, depth + 1));
      }
      result = Object.freeze(items);
    } else {
      const entries = Object.keys(descriptors).sort().map((key) => {
        const d = descriptors[key];
        if (!("value" in d) || !d.enumerable) throw new PreparationFailure("invalid_json");
        return [key, copy(d.value, depth + 1)] as const;
      });
      result = Object.freeze(Object.fromEntries(entries));
    }
    ancestors.delete(v);
    return result;
  }
  return copy(value, 0);
}

export function parseRequestRoute(value: unknown): RequestRoute {
  const result = routeSchema.safeParse(value);
  if (!result.success) throw new PreparationFailure("invalid_route");
  return Object.freeze(result.data);
}
export function tokenBound(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new PreparationFailure("invalid_token_bound");
  return value;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) => JSON.stringify(snapshotJson(value));

export type RequestEnvelope = Readonly<{
  route: RequestRoute; body: Json; bodyJson: string; bodyDigest: string; maxOutputTokens: number;
}>;
export type PreparedRequest = RequestEnvelope & Readonly<{ inputReservation: number; envelopeDigest: string }>;
export type PreparedIdentity = Readonly<{ route: RequestRoute; maxOutputTokens: number; envelopeDigest: string }>;
/** Retain this identity separately from any later request presented for dispatch. */
export function preparedIdentity(request: PreparedRequest): PreparedIdentity {
  return Object.freeze({ route: parseRequestRoute(request.route), maxOutputTokens: request.maxOutputTokens,
    envelopeDigest: request.envelopeDigest });
}
export type InputMeter = {
  /** Must explicitly support the exact route, model, schema, and stage. */
  supports(route: RequestRoute): boolean;
  /** Must include the complete body and provider overhead. No built-in estimate exists. */
  measure(envelope: RequestEnvelope): number;
};

function envelopeDigest(request: RequestEnvelope, inputReservation: number): string {
  return digest(canonical({ route: request.route, bodyDigest: request.bodyDigest,
    maxOutputTokens: request.maxOutputTokens, inputReservation }));
}

/** Pure preparation only. The caller supplies a complete provider body and a reviewed local meter. */
export function prepareRequest(input: {
  route: RequestRoute; body: unknown; maxOutputTokens: number;
}, meter: InputMeter): PreparedRequest {
  const route = parseRequestRoute(input.route);
  const maxOutputTokens = tokenBound(input.maxOutputTokens);
  if (maxOutputTokens > REQUEST_OUTPUT_LIMITS[route.stage]) throw new PreparationFailure("output_request_limit");
  if (meter.supports(route) !== true) throw new PreparationFailure("unsupported_meter_route");
  const body = snapshotJson(input.body), bodyJson = JSON.stringify(body);
  const envelope = Object.freeze({ route, body, bodyJson, bodyDigest: digest(bodyJson), maxOutputTokens });
  const inputReservation = tokenBound(meter.measure(envelope));
  if (inputReservation > POLICY.inputPerRequest) throw new PreparationFailure("context_budget_exceeded");
  return Object.freeze({ ...envelope, inputReservation, envelopeDigest: envelopeDigest(envelope, inputReservation) });
}

/** Detect accidental drift. Digests provide consistency checks, not authentication of untrusted callers. */
export function verifyPreparedRequest(request: PreparedRequest, expected: PreparedIdentity): void {
  const route = parseRequestRoute(request.route);
  if (canonical(route) !== canonical(parseRequestRoute(expected.route)) || request.maxOutputTokens !== expected.maxOutputTokens) {
    throw new PreparationFailure("request_identity_changed");
  }
  if (tokenBound(request.maxOutputTokens) > REQUEST_OUTPUT_LIMITS[route.stage] ||
      tokenBound(request.inputReservation) > POLICY.inputPerRequest) throw new PreparationFailure("invalid_reservation");
  if (canonical(request.body) !== request.bodyJson || digest(request.bodyJson) !== request.bodyDigest ||
      envelopeDigest(request, request.inputReservation) !== request.envelopeDigest) throw new PreparationFailure("request_digest_changed");
  if (request.envelopeDigest !== expected.envelopeDigest) throw new PreparationFailure("request_identity_changed");
}

/** Uses the existing serial budget. A stopped result never authorizes dispatch. */
export function reservePreparedRequest(budget: Budget, id: string, request: PreparedRequest,
  expected: PreparedIdentity, nowMs: number): Budget {
  verifyPreparedRequest(request, expected);
  return reserveWork(budget, { id, inputTokens: request.inputReservation, outputTokens: request.maxOutputTokens }, nowMs);
}
