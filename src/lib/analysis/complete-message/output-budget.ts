import { finishWork, reserveWork, type Budget } from "./budget";
import { POLICY } from "./contract";
import { parseRequestRoute, PreparationFailure, REQUEST_OUTPUT_LIMITS, snapshotJson, tokenBound,
  type Json, type RequestRoute } from "./prepared-request";

/** One indivisible candidate packet includes its complete range, context, and evidence. */
export type ScoringPacket = Readonly<{ candidate: Json; context: Json; evidence: Json }>;
export type BatchMeter = {
  supports(route: RequestRoute): boolean;
  /** Include the full request envelope and an upper bound for every complete response field. */
  measure(route: RequestRoute, packets: readonly ScoringPacket[]): { inputTokens: number; outputTokens: number };
};
export type ScoringBatch = Readonly<{
  packets: readonly ScoringPacket[]; inputReservation: number; outputBound: number; maxOutputTokens: number;
}>;

/** Plan only. Never advances a real budget or returns a partial plan when any packet cannot fit. */
export function planScoringBatches(input: {
  route: RequestRoute; packets: readonly ScoringPacket[]; budget: Budget; nowMs: number;
}, meter: BatchMeter): readonly ScoringBatch[] {
  const route = parseRequestRoute(input.route);
  if (route.stage !== "analysis_scoring") throw new PreparationFailure("scoring_route_required");
  if (meter.supports(route) !== true) throw new PreparationFailure("unsupported_meter_route");
  if (input.budget.stopReason || input.budget.pending) throw new PreparationFailure(input.budget.stopReason ?? "request_pending");
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < input.budget.lastTimeMs) throw new PreparationFailure("invalid_clock");
  if (input.nowMs - input.budget.startedAtMs >= POLICY.analysisMs) throw new PreparationFailure("analysis_time_limit");
  if (input.packets.length > POLICY.scoring) throw new PreparationFailure("scoring_candidate_limit");
  const packets = input.packets.map((packet) => {
    // Snapshot every packet before calling any injected dependency.
    const copy = snapshotJson(packet) as ScoringPacket;
    if (!copy || typeof copy !== "object" || Array.isArray(copy) ||
        Object.keys(copy).sort().join(",") !== "candidate,context,evidence") throw new PreparationFailure("invalid_scoring_packet");
    return copy;
  });
  const cap = REQUEST_OUTPUT_LIMITS.analysis_scoring;
  const measure = (group: readonly ScoringPacket[]): ScoringBatch => {
    const frozen = Object.freeze([...group]);
    const counts = meter.measure(route, frozen);
    return Object.freeze({ packets: frozen, inputReservation: tokenBound(counts.inputTokens),
      outputBound: tokenBound(counts.outputTokens), maxOutputTokens: cap });
  };
  const fits = (batch: ScoringBatch) => batch.inputReservation <= POLICY.inputPerRequest && batch.outputBound <= cap;
  const batches: ScoringBatch[] = [];
  let current: ScoringBatch | undefined;
  for (const packet of packets) {
    const next = measure([...(current?.packets ?? []), packet]);
    if (fits(next)) { current = next; continue; }
    if (current) batches.push(current);
    const single = current ? measure([packet]) : next;
    if (!fits(single)) throw new PreparationFailure(single.inputReservation > POLICY.inputPerRequest
      ? "context_budget_exceeded" : "complete_response_exceeds_limit");
    current = single;
  }
  if (current) batches.push(current);

  // Projection only. Reserve the full existing 2,048-token cap for each batch, without refunds.
  // Execution must reserve each prepared request again against its current budget and clock.
  let projected = input.budget;
  for (const [index, batch] of batches.entries()) {
    const id = `planned-score-${index}`;
    projected = reserveWork(projected, { id, inputTokens: batch.inputReservation, outputTokens: cap }, input.nowMs);
    if (projected.stopReason) throw new PreparationFailure(projected.stopReason);
    projected = finishWork(projected, { id, inputTokens: 0, outputTokens: 0 }, input.nowMs);
    if (projected.stopReason) throw new PreparationFailure(projected.stopReason);
  }
  return Object.freeze(batches);
}
