export const DEFAULT_CANDIDATE_LIMIT = 18;
export const DEFAULT_TARGET_CLIP_COUNT = 6;

export interface CandidateLimitInput {
  targetClipCount: number;
  churchOverride?: unknown;
  masterDefault?: number;
  masterMaximum?: number;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Reads the scheduled clip count snapshotted when a project is created: six for a weekly service
 * or three for each service when a church has two services per week.
 */
export function readTargetClipCount(processingConfig: unknown): number {
  if (processingConfig && typeof processingConfig === "object" && "targetClipCount" in processingConfig) {
    const value = (processingConfig as { targetClipCount?: unknown }).targetClipCount;
    if (isPositiveInteger(value)) return value;
  }
  return DEFAULT_TARGET_CLIP_COUNT;
}

/**
 * Resolves the retained candidate-pool ceiling. A valid hidden church override takes precedence
 * over the master default. The master maximum caps either value. The scheduled count is the final
 * minimum, because every scheduled slot must be able to receive a candidate.
 */
export function resolveCandidateLimit(input: CandidateLimitInput): number {
  const masterDefault = input.masterDefault ?? DEFAULT_CANDIDATE_LIMIT;
  const masterMaximum = input.masterMaximum ?? DEFAULT_CANDIDATE_LIMIT;
  const requested = isPositiveInteger(input.churchOverride) ? input.churchOverride : masterDefault;
  return Math.max(input.targetClipCount, Math.min(requested, masterMaximum));
}
