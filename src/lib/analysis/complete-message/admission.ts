import { POLICY } from "./contract";
import type { Accepted, Decision } from "./policy";

const order = (a: Accepted, b: Accepted) => a.content.startMs - b.content.startMs
  || a.content.endMs - b.content.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function sample(items: Accepted[], count: number): Accepted[] {
  if (count >= items.length) return [...items];
  if (count === 0) return [];
  if (count === 1) return [items[Math.floor((items.length - 1) / 2)]];
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * (items.length - 1) / (count - 1))]);
}

function quotas(a: number, b: number, limit: number): [number, number] {
  const first = Math.min(a, Math.ceil(limit / 2) + Math.max(0, Math.floor(limit / 2) - b));
  return [first, Math.min(b, limit - first)];
}

function byBand(items: Accepted[], count: number): Accepted[] {
  const standard = items.filter((p) => p.band === "standard");
  const extended = items.filter((p) => p.band === "extended");
  const [a, b] = quotas(standard.length, extended.length, count);
  return [...sample(standard, a), ...sample(extended, b)].sort(order);
}

/** Call only with decisions from evaluateResponse. This function performs no semantic or overlap deduplication. */
export function admitDecisions(decisions: readonly Decision[]) {
  const complete = decisions.filter((p): p is Accepted => p.state === "complete").sort(order);
  const short = complete.filter((p) => p.origin === "short");
  const message = complete.filter((p) => p.origin === "message");
  const [a, b] = quotas(short.length, message.length, POLICY.candidates);
  const candidates = [...byBand(short, a), ...byBand(message, b)].sort(order);
  const scoring = byBand(candidates, POLICY.scoring);
  return {
    candidates, scoring,
    counts: {
      supplied: decisions.length, complete: complete.length, admitted: candidates.length,
      omittedByPolicy: decisions.length - complete.length, omittedByCapacity: complete.length - candidates.length,
      standard: candidates.filter((p) => p.band === "standard").length,
      extended: candidates.filter((p) => p.band === "extended").length,
    },
    coverage: candidates.length ? {
      earliestStartMs: candidates[0].content.startMs,
      latestEndMs: Math.max(...candidates.map((p) => p.content.endMs)),
    } : null,
  };
}
