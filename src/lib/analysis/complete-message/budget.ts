import { z } from "zod";
import { POLICY, identifier, integer } from "./contract";

const reservationSchema = z.object({
  id: identifier, inputTokens: integer, outputTokens: integer,
}).strict();
type Reservation = z.infer<typeof reservationSchema>;
export type Budget = Readonly<{
  startedAtMs: number; lastTimeMs: number; requests: number; inputTokens: number; outputTokens: number;
  pending: (Reservation & { startedAtMs: number; deadlineMs: number }) | null;
  stopReason: string | null;
}>;

export function initialBudget(nowMs: number): Budget {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > Number.MAX_SAFE_INTEGER - POLICY.analysisMs) {
    throw new RangeError("Invalid clock value.");
  }
  return { startedAtMs: nowMs, lastTimeMs: nowMs, requests: 0, inputTokens: 0, outputTokens: 0, pending: null, stopReason: null };
}

function timeProblem(state: Budget, nowMs: number): string | undefined {
  if (!Number.isSafeInteger(nowMs) || nowMs < state.lastTimeMs) return "invalid_clock";
}
const stopped = (state: Budget, reason: string): Budget => ({ ...state, stopReason: reason });

/** Serial reservations count every attempt. State contains conservative token reservations, without refunds. */
export function reserveWork(state: Budget, rawReservation: unknown, nowMs: number): Budget {
  if (state.stopReason) return state;
  const time = timeProblem(state, nowMs);
  if (time) return stopped(state, time);
  if (state.pending) return stopped(state, "request_pending");
  const parsed = reservationSchema.safeParse(rawReservation);
  if (!parsed.success) return stopped(state, "invalid_reservation");
  const r = parsed.data;
  if (nowMs - state.startedAtMs >= POLICY.analysisMs) return stopped(state, "analysis_time_limit");
  if (state.requests >= POLICY.requests) return stopped(state, "request_limit");
  if (r.inputTokens > POLICY.inputPerRequest) return stopped(state, "context_budget_exceeded");
  if (state.inputTokens + r.inputTokens > POLICY.totalInput) return stopped(state, "input_token_limit");
  if (state.outputTokens + r.outputTokens > POLICY.totalOutput) return stopped(state, "output_token_limit");
  return {
    ...state, lastTimeMs: nowMs, requests: state.requests + 1,
    inputTokens: state.inputTokens + r.inputTokens, outputTokens: state.outputTokens + r.outputTokens,
    pending: { ...r, startedAtMs: nowMs, deadlineMs: Math.min(nowMs + POLICY.requestMs, state.startedAtMs + POLICY.analysisMs) },
  };
}

/** The caller supplies time and usage. This function does not wait, cancel, or retry a request. */
export function finishWork(state: Budget, rawUsage: unknown, nowMs: number): Budget {
  if (state.stopReason) return state;
  const time = timeProblem(state, nowMs);
  if (time) return stopped(state, time);
  const parsed = reservationSchema.safeParse(rawUsage);
  if (!parsed.success) return stopped(state, "invalid_usage");
  const usage = parsed.data, pending = state.pending;
  if (!pending || pending.id !== usage.id) return stopped(state, "request_mismatch");
  if (nowMs > pending.deadlineMs) return stopped(state,
    pending.deadlineMs === state.startedAtMs + POLICY.analysisMs ? "analysis_time_limit" : "request_time_limit");
  if (usage.inputTokens > pending.inputTokens || usage.outputTokens > pending.outputTokens) return stopped(state, "reservation_exceeded");
  return { ...state, pending: null, lastTimeMs: nowMs };
}

export function budgetStatus(state: Budget): "complete" | "analysis_incomplete" {
  return state.stopReason || state.pending ? "analysis_incomplete" : "complete";
}
